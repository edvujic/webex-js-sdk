/*!
 * Copyright (c) 2015-2020 Cisco Systems, Inc. See LICENSE file.
 */

import {EventEmitter} from 'events';
import util from 'util';

import {proxyEvents, retry, transferEvents} from '@webex/common';
import {
  HttpStatusInterceptor,
  defaults as requestDefaults,
  protoprepareFetchOptions as prepareFetchOptions,
  setTimingsAndFetch as _setTimingsAndFetch,
} from '@webex/http-core';
import {defaultsDeep, get, isFunction, isString, last, merge, omit, set, unset} from 'lodash';
import AmpState from 'ampersand-state';
import uuid from 'uuid';

import AuthInterceptor from './interceptors/auth';
import NetworkTimingInterceptor from './interceptors/network-timing';
import PayloadTransformerInterceptor from './interceptors/payload-transformer';
import RedirectInterceptor from './interceptors/redirect';
import RequestEventInterceptor from './interceptors/request-event';
import RequestLoggerInterceptor from './interceptors/request-logger';
import RequestTimingInterceptor from './interceptors/request-timing';
import ResponseLoggerInterceptor from './interceptors/response-logger';
import WebexHttpError from './lib/webex-http-error';
import UserAgentInterceptor from './interceptors/user-agent';
import WebexTrackingIdInterceptor from './interceptors/webex-tracking-id';
import WebexUserAgentInterceptor from './interceptors/webex-user-agent';
import RateLimitInterceptor from './interceptors/rate-limit';
import EmbargoInterceptor from './interceptors/embargo';
import DefaultOptionsInterceptor from './interceptors/default-options';
import HostMapInterceptor from './lib/services/interceptors/hostmap';
import config from './config';
import {makeWebexStore} from './lib/storage';
import mixinWebexCorePlugins from './lib/webex-core-plugin-mixin';
import mixinWebexInternalCorePlugins from './lib/webex-internal-core-plugin-mixin';
import WebexInternalCore from './webex-internal-core';

// TODO replace the Interceptor.create with Reflect.construct (
// Interceptor.create exists because new was really hard to call on an array of
// constructors)
const interceptors = {
  WebexTrackingIdInterceptor: WebexTrackingIdInterceptor.create,
  RequestEventInterceptor: RequestEventInterceptor.create,
  RateLimitInterceptor: RateLimitInterceptor.create,
  /* eslint-disable no-extra-parens */
  RequestLoggerInterceptor:
    process.env.ENABLE_NETWORK_LOGGING || process.env.ENABLE_VERBOSE_NETWORK_LOGGING
      ? RequestLoggerInterceptor.create
      : undefined,
  ResponseLoggerInterceptor:
    process.env.ENABLE_NETWORK_LOGGING || process.env.ENABLE_VERBOSE_NETWORK_LOGGING
      ? ResponseLoggerInterceptor.create
      : undefined,
  /* eslint-enable no-extra-parens */
  RequestTimingInterceptor: RequestTimingInterceptor.create,
  ServiceInterceptor: undefined,
  UserAgentInterceptor: UserAgentInterceptor.create,
  WebexUserAgentInterceptor: WebexUserAgentInterceptor.create,
  AuthInterceptor: AuthInterceptor.create,
  KmsDryErrorInterceptor: undefined,
  PayloadTransformerInterceptor: PayloadTransformerInterceptor.create,
  ConversationInterceptor: undefined,
  RedirectInterceptor: RedirectInterceptor.create,
  HttpStatusInterceptor() {
    return HttpStatusInterceptor.create({
      error: WebexHttpError,
    });
  },
  NetworkTimingInterceptor: NetworkTimingInterceptor.create,
  EmbargoInterceptor: EmbargoInterceptor.create,
  DefaultOptionsInterceptor: DefaultOptionsInterceptor.create,
  HostMapInterceptor: HostMapInterceptor.create,
};

const preInterceptors = [
  'ResponseLoggerInterceptor',
  'RequestTimingInterceptor',
  'RequestEventInterceptor',
  'WebexTrackingIdInterceptor',
  'RateLimitInterceptor',
];

const postInterceptors = [
  'HttpStatusInterceptor',
  'NetworkTimingInterceptor',
  'EmbargoInterceptor',
  'RequestLoggerInterceptor',
  'RateLimitInterceptor',
];

const MAX_FILE_SIZE_IN_MB = 2048;

/**
 * @class
 */
const WebexCore = AmpState.extend({
  version: PACKAGE_VERSION,

  children: {
    internal: WebexInternalCore,
  },

  constructor(attrs = {}, options) {
    if (typeof attrs === 'string') {
      attrs = {
        credentials: {
          supertoken: {
            // eslint-disable-next-line camelcase
            access_token: attrs,
          },
        },
      };
    } else {
      // Reminder: order is important here
      [
        'credentials.authorization',
        'authorization',
        'credentials.supertoken.supertoken',
        'supertoken',
        'access_token',
        'credentials.authorization.supertoken',
      ].forEach((path) => {
        const val = get(attrs, path);

        if (val) {
          unset(attrs, path);
          set(attrs, 'credentials.supertoken', val);
        }
      });

      ['credentials', 'credentials.authorization'].forEach((path) => {
        const val = get(attrs, path);

        if (typeof val === 'string') {
          unset(attrs, path);
          set(attrs, 'credentials.supertoken', val);
        }
      });

      if (typeof get(attrs, 'credentials.access_token') === 'string') {
        // Send access_token to get validated and corrected and then set it
        set(
          attrs,
          'credentials.access_token',
          this.bearerValidator(get(attrs, 'credentials.access_token').trim())
        );

        set(attrs, 'credentials.supertoken', attrs.credentials);
      }
    }

    return Reflect.apply(AmpState, this, [attrs, options]);
  },

  derived: {
    boundedStorage: {
      deps: [],
      fn() {
        return makeWebexStore('bounded', this);
      },
    },
    unboundedStorage: {
      deps: [],
      fn() {
        return makeWebexStore('unbounded', this);
      },
    },
    ready: {
      deps: ['loaded', 'internal.ready'],
      fn() {
        return (
          this.loaded &&
          Object.keys(this._children).reduce(
            (ready, name) => ready && this[name] && this[name].ready !== false,
            true
          )
        );
      },
    },
  },

  session: {
    config: {
      type: 'object',
    },
    /**
     * When true, indicates that the initial load from the storage layer is
     * complete
     * @instance
     * @memberof WebexCore
     * @type {boolean}
     */
    loaded: {
      default: false,
      type: 'boolean',
    },
    request: {
      setOnce: true,
      // It's supposed to be a function, but that's not a type defined in
      // Ampersand
      type: 'any',
    },
    sessionId: {
      type: 'string',
    },
  },

  /**
   * @instance
   * @memberof WebexCore
   * @param {[type]} args
   * @returns {[type]}
   */
  refresh(...args) {
    return this.credentials.refresh(...args);
  },

  /**
   * Applies the directionally appropriate transforms to the specified object
   * @param {string} direction
   * @param {Object} object
   * @returns {Promise}
   */
  transform(direction, object) {
    const predicates = this.config.payloadTransformer.predicates.filter(
      (p) => !p.direction || p.direction === direction
    );
    const ctx = {
      webex: this,
    };

    return Promise.all(
      predicates.map((p) =>
        p.test(ctx, object).then((shouldTransform) => {
          if (!shouldTransform) {
            return undefined;
          }

          return (
            p
              .extract(object)
              // eslint-disable-next-line max-nested-callbacks
              .then((target) => ({
                name: p.name,
                target,
              }))
          );
        })
      )
    )
      .then((data) =>
        data
          .filter((d) => Boolean(d))
          // eslint-disable-next-line max-nested-callbacks
          .reduce(
            (promise, {name, target, alias}) =>
              promise.then(() => {
                if (alias) {
                  return this.applyNamedTransform(direction, alias, target);
                }

                return this.applyNamedTransform(direction, name, target);
              }),
            Promise.resolve()
          )
      )
      .then(() => object);
  },

  /**
   * Applies the directionally appropriate transform to the specified parameters
   * @param {string} direction
   * @param {Object} ctx
   * @param {string} name
   * @returns {Promise}
   */
  applyNamedTransform(direction, ctx, name, ...rest) {
    if (isString(ctx)) {
      rest.unshift(name);
      name = ctx;
      ctx = {
        webex: this,
        transform: (...args) => this.applyNamedTransform(direction, ctx, ...args),
      };
    }

    const transforms = ctx.webex.config.payloadTransformer.transforms.filter(
      (tx) => tx.name === name && (!tx.direction || tx.direction === direction)
    );

    // too many implicit returns on the same line is difficult to interpret
    // eslint-disable-next-line arrow-body-style
    return transforms
      .reduce(
        (promise, tx) =>
          promise.then(() => {
            if (tx.alias) {
              return ctx.transform(tx.alias, ...rest);
            }

            return Promise.resolve(tx.fn(ctx, ...rest));
          }),
        Promise.resolve()
      )
      .then(() => last(rest));
  },

  /**
   * @private
   * @returns {Window}
   */
  getWindow() {
    // eslint-disable-next-line
    return window;
  },

  /**
   * Initializer
   *
   * @emits WebexCore#loaded
   * @emits WebexCore#ready
   * @instance
   * @memberof WebexCore
   * @param {Object} attrs
   * @returns {WebexCore}
   */
  initialize(attrs = {}) {
    this.config = merge({}, config, attrs.config);

    // There's some unfortunateness with the way {@link AmpersandState#children}
    // get initialized. We'll fire the change:config event so that
    // {@link WebexPlugin#initialize()} can use
    // `this.listenToOnce(parent, 'change:config', () => {});` to act on config
    // during initialization
    this.trigger('change:config');

    const onLoaded = () => {
      if (this.loaded) {
        /**
         * Fires when all data has been loaded from the storage layer
         * @event loaded
         * @instance
         * @memberof WebexCore
         */
        this.trigger('loaded');

        this.stopListening(this, 'change:loaded', onLoaded);
      }
    };

    // This needs to run on nextTick or we'll never be able to wire up listeners
    process.nextTick(() => {
      this.listenToAndRun(this, 'change:loaded', onLoaded);
    });

    const onReady = () => {
      if (this.ready) {
        /**
         * Fires when all plugins have fully initialized
         * @event ready
         * @instance
         * @memberof WebexCore
         */
        this.trigger('ready');

        this.stopListening(this, 'change:ready', onReady);
      }
    };

    // This needs to run on nextTick or we'll never be able to wire up listeners
    process.nextTick(() => {
      this.listenToAndRun(this, 'change:ready', onReady);
    });

    // Make nested events propagate in a consistent manner
    Object.keys(this.constructor.prototype._children).forEach((key) => {
      this.listenTo(this[key], 'change', (...args) => {
        args.unshift(`change:${key}`);
        this.trigger(...args);
      });
    });

    const addInterceptor = (ints, key) => {
      const interceptorsObj = this.config.interceptors || interceptors;
      const interceptor = interceptorsObj[key];

      if (!isFunction(interceptor)) {
        return ints;
      }

      ints.push(Reflect.apply(interceptor, this, []));

      return ints;
    };

    let ints = [];

    if (this.config.interceptors) {
      Object.keys(this.config.interceptors).reduce(addInterceptor, ints);
    } else {
      ints = preInterceptors.reduce(addInterceptor, ints);
      ints = Object.keys(interceptors)
        .filter((key) => !(preInterceptors.includes(key) || postInterceptors.includes(key)))
        .reduce(addInterceptor, ints);
      ints = postInterceptors.reduce(addInterceptor, ints);
    }

    this.request = requestDefaults({
      json: true,
      interceptors: ints,
    });

    this.prepareFetchOptions = prepareFetchOptions({
      json: true,
      interceptors: ints,
    });

    this.setTimingsAndFetch = _setTimingsAndFetch;

    let sessionId = `${get(this, 'config.trackingIdPrefix', 'webex-js-sdk')}_${get(
      this,
      'config.trackingIdBase',
      uuid.v4()
    )}`;

    if (get(this, 'config.trackingIdSuffix')) {
      sessionId += `_${get(this, 'config.trackingIdSuffix')}`;
    }

    this.sessionId = sessionId;
  },

  /**
   * setConfig
   *
   * Allows updating config
   *
   * @instance
   * @memberof WebexCore
   * @param {Object} newConfig
   * @returns {null}
   */
  setConfig(newConfig = {}) {
    this.config = merge({}, this.config, newConfig);
  },

  /**
   *
   * Check if access token is correctly formated and correct if it's not
   * Warn user if token string has errors in it
   * @param {string} token
   * @returns {string}
   */
  bearerValidator(token) {
    if (token.includes('Bearer') && token.split(' ').length - 1 === 0) {
      console.warn(
        `Your access token does not have a space between 'Bearer' and the token, please add a space to it or replace it with this already fixed version:\n\n${token
          .replace('Bearer', 'Bearer ')
          .replace(/\s+/g, ' ')}`
      );
      console.info(
        "Tip: You don't need to add 'Bearer' to the access_token field. The token by itself is fine"
      );

      return token.replace('Bearer', 'Bearer ').replace(/\s+/g, ' ');
    }
    // Allow elseIf return
    // eslint-disable-next-line  no-else-return
    else if (token.split(' ').length - 1 > 1) {
      console.warn(
        `Your access token has ${
          token.split(' ').length - 2
        } too many spaces, please use this format:\n\n${token.replace(/\s+/g, ' ')}`
      );
      console.info(
        "Tip: You don't need to add 'Bearer' to the access_token field, the token by itself is fine"
      );

      return token.replace(/\s+/g, ' ');
    }

    return token.replace(/\s+/g, ' '); // Clean it anyway (just in case)
  },

  /**
   * @instance
   * @memberof WebexPlugin
   * @param {number} depth
   * @private
   * @returns {Object}
   */
  inspect(depth) {
    return util.inspect(
      omit(
        this.serialize({
          props: true,
          session: true,
          derived: true,
        }),
        'boundedStorage',
        'unboundedStorage',
        'request',
        'config'
      ),
      {depth}
    );
  },

  /**
   * Invokes all `onBeforeLogout` handlers in the scope of their plugin, clears
   * all stores, and revokes the access token
   * Note: If you're using the sdk in a server environment, you may be more
   * interested in {@link `webex.internal.mercury.disconnect()`| Mercury#disconnect()}
   * and {@link `webex.internal.device.unregister()`|Device#unregister()}
   * or {@link `webex.phone.unregister()`|Phone#unregister}
   * @instance
   * @memberof WebexCore
   * @param {Object} options Passed as the first argument to all
   * `onBeforeLogout` handlers
   * @returns {Promise}
   */
  logout(options, ...rest) {
    // prefer the refresh token, but for clients that don't have one, fallback
    // to the access token
    const token =
      this.credentials.supertoken &&
      (this.credentials.supertoken.refresh_token || this.credentials.supertoken.access_token);

    options = Object.assign({token}, options);

    // onBeforeLogout should be executed in the opposite order in which handlers
    // were registered. In that way, wdm unregister() will be above mercury
    // disconnect(), but disconnect() will execute first.
    // eslint-disable-next-line arrow-body-style
    return this.config.onBeforeLogout
      .reverse()
      .reduce(
        (promise, {plugin, fn}) =>
          promise.then(() => {
            return (
              Promise.resolve(
                Reflect.apply(fn, this[plugin] || this.internal[plugin], [options, ...rest])
              )
                // eslint-disable-next-line max-nested-callbacks
                .catch((err) => {
                  this.logger.warn(`onBeforeLogout from plugin ${plugin}: failed`, err);
                })
            );
          }),
        Promise.resolve()
      )
      .then(() => Promise.all([this.boundedStorage.clear(), this.unboundedStorage.clear()]))
      .then(() => this.credentials.invalidate(...rest))
      .then(
        () =>
          this.authorization &&
          this.authorization.logout &&
          this.authorization.logout(options, ...rest)
      )
      .then(() => this.trigger('client:logout'));
  },

  /**
   * General purpose wrapper to submit metrics via the metrics plugin (if the
   * metrics plugin is installed)
   * @instance
   * @memberof WebexCore
   * @returns {Promise}
   */
  measure(...args) {
    if (this.metrics) {
      return this.metrics.sendUnstructured(...args);
    }

    return Promise.resolve();
  },

  async upload(options) {
    if (!options.file) {
      return Promise.reject(new Error('`options.file` is required'));
    }

    options.phases = options.phases || {};
    options.phases.initialize = options.phases.initialize || {};
    options.phases.upload = options.phases.upload || {};
    options.phases.finalize = options.phases.finalize || {};

    defaultsDeep(
      options.phases.initialize,
      {
        method: 'POST',
        body: {
          uploadProtocol: 'content-length',
        },
      },
      omit(options, 'file', 'phases')
    );

    defaultsDeep(options.phases.upload, {
      method: 'PUT',
      json: false,
      withCredentials: false,
      body: options.file,
      headers: {
        'x-trans-id': uuid.v4(),
        authorization: undefined,
      },
    });

    defaultsDeep(
      options.phases.finalize,
      {
        method: 'POST',
      },
      omit(options, 'file', 'phases')
    );

    const shunt = new EventEmitter();

    const promise = this._uploadPhaseInitialize(options)
      .then(() => {
        const p = this._uploadPhaseUpload(options);

        transferEvents('progress', p, shunt);

        return p;
      })
      .then((...args) => this._uploadPhaseFinalize(options, ...args))
      .then((res) => ({...res.body, ...res.headers}));

    proxyEvents(shunt, promise);

    return promise;
  },

  _uploadPhaseInitialize: function _uploadPhaseInitialize(options) {
    this.logger.debug('client: initiating upload session');

    return this.request(options.phases.initialize)
      .then((...args) => {
        const fileUploadSizeLimitInBytes =
          (args[0].body.fileUploadSizeLimit || MAX_FILE_SIZE_IN_MB) * 1024 * 1024;
        const currentFileSizeInBytes = options.file.byteLength;

        if (fileUploadSizeLimitInBytes && fileUploadSizeLimitInBytes < currentFileSizeInBytes) {
          return this._uploadAbortSession(currentFileSizeInBytes, ...args);
        }

        return this._uploadApplySession(options, ...args);
      })
      .then((res) => {
        this.logger.debug('client: initiated upload session');

        return res;
      });
  },

  _uploadAbortSession(currentFileSizeInBytes, response) {
    this.logger.debug('client: deleting uploaded file');

    return this.request({
      method: 'DELETE',
      url: response.body.url,
      headers: response.options.headers,
    }).then(() => {
      this.logger.debug('client: deleting uploaded file complete');

      const abortErrorDetails = {
        currentFileSizeInBytes,
        fileUploadSizeLimitInMB: response.body.fileUploadSizeLimit || MAX_FILE_SIZE_IN_MB,
        message: 'file-upload-size-limit-enabled',
      };

      return Promise.reject(new Error(`${JSON.stringify(abortErrorDetails)}`));
    });
  },

  _uploadApplySession(options, res) {
    const session = res.body;

    ['upload', 'finalize'].reduce((opts, key) => {
      opts[key] = Object.keys(opts[key]).reduce((phaseOptions, phaseKey) => {
        if (phaseKey.startsWith('$')) {
          phaseOptions[phaseKey.substr(1)] = phaseOptions[phaseKey](session);
          Reflect.deleteProperty(phaseOptions, phaseKey);
        }

        return phaseOptions;
      }, opts[key]);

      return opts;
    }, options.phases);
  },

  @retry
  _uploadPhaseUpload(options) {
    this.logger.debug('client: uploading file');

    const promise = this.request(options.phases.upload).then((res) => {
      this.logger.debug('client: uploaded file');

      return res;
    });

    proxyEvents(options.phases.upload.upload, promise);

    /* istanbul ignore else */
    if (process.env.NODE_ENV === 'test') {
      promise.on('progress', (event) => {
        this.logger.info('upload progress', event.loaded, event.total);
      });
    }

    return promise;
  },

  _uploadPhaseFinalize: function _uploadPhaseFinalize(options) {
    this.logger.debug('client: finalizing upload session');

    return this.request(options.phases.finalize).then((res) => {
      this.logger.debug('client: finalized upload session');

      return res;
    });
  },
});

WebexCore.version = PACKAGE_VERSION;

mixinWebexInternalCorePlugins(WebexInternalCore, config, interceptors);
mixinWebexCorePlugins(WebexCore, config, interceptors);

export default WebexCore;

/**
 * @method registerPlugin
 * @param {string} name
 * @param {function} constructor
 * @param {Object} options
 * @param {Array<string>} options.proxies
 * @param {Object} options.interceptors
 * @returns {null}
 */
export function registerPlugin(name, constructor, options = {}) {
  WebexCore.registerPlugin(name, constructor, options);
}

/**
 * Registers plugins used by internal products that do not talk to public APIs.
 * @method registerInternalPlugin
 * @param {string} name
 * @param {function} constructor
 * @param {Object} options
 * @param {Object} options.interceptors
 * @private
 * @returns {null}
 */
export function registerInternalPlugin(name, constructor, options) {
  WebexInternalCore.registerPlugin(name, constructor, options);
}
