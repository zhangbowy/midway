import { isClass, Provide, Scope, ScopeEnum } from '@midwayjs/decorator';
import {
  CommonMiddleware,
  IMiddleware,
  IMidwayContainer,
  FunctionMiddleware,
} from '../interface';
import { pathToRegexp } from '../util/pathToRegexp';
import { MidwayCommonError, MidwayParameterError } from '../error';

@Provide()
@Scope(ScopeEnum.Singleton)
export class MidwayMiddlewareService<T> {
  constructor(readonly applicationContext: IMidwayContainer) {}

  async compose(
    middleware: Array<CommonMiddleware<T> | string>,
    name?: string
  ) {
    if (!Array.isArray(middleware)) {
      throw new MidwayParameterError('Middleware stack must be an array');
    }

    const newMiddlewareArr = [];

    for (let fn of middleware) {
      if (isClass(fn) || typeof fn === 'string') {
        if (
          typeof fn === 'string' &&
          !this.applicationContext.hasDefinition(fn)
        ) {
          throw new MidwayCommonError(
            'Middleware definition not found in midway container'
          );
        }
        const classMiddleware = await this.applicationContext.getAsync<
          IMiddleware<T>
        >(fn as any);
        if (classMiddleware) {
          fn = classMiddleware.resolve();
          if (!classMiddleware.match && !classMiddleware.ignore) {
            (fn as any)._name = classMiddleware.constructor.name;
            // just got fn
            newMiddlewareArr.push(fn);
          } else {
            // wrap ignore and match
            const mw = fn;
            const match = pathMatching({
              match: classMiddleware.match,
              ignore: classMiddleware.ignore,
            });
            fn = (ctx, next, options) => {
              if (!match(ctx)) return next();
              return mw(ctx, next, options);
            };
            (fn as any)._name = classMiddleware.constructor.name;
            newMiddlewareArr.push(fn);
          }
        } else {
          throw new MidwayCommonError('Middleware must have resolve method!');
        }
      } else {
        newMiddlewareArr.push(fn);
      }
    }

    /**
     * @param {Object} context
     * @param next
     * @return {Promise}
     * @api public
     */
    const composeFn = (context, next?) => {
      // last called middleware #
      let index = -1;
      return dispatch(0);

      function dispatch(i) {
        if (i <= index)
          return Promise.reject(
            new MidwayCommonError('next() called multiple times')
          );
        index = i;
        let fn = (newMiddlewareArr as Array<FunctionMiddleware<T>>)[i];
        if (i === newMiddlewareArr.length) fn = next;
        if (!fn) return Promise.resolve();
        try {
          return Promise.resolve(
            fn(context, dispatch.bind(null, i + 1), {
              index,
            })
          );
        } catch (err) {
          return Promise.reject(err);
        }
      }
    };
    if (name) {
      composeFn._name = name;
    }
    return composeFn;
  }
}

export function pathMatching(options) {
  options = options || {};
  if (options.match && options.ignore)
    throw new MidwayCommonError(
      'options.match and options.ignore can not both present'
    );
  if (!options.match && !options.ignore) return () => true;

  const matchFn = options.match
    ? toPathMatch(options.match)
    : toPathMatch(options.ignore);

  return function pathMatch(ctx?) {
    const matched = matchFn(ctx);
    return options.match ? matched : !matched;
  };
}

function toPathMatch(pattern) {
  if (typeof pattern === 'string') {
    const reg = pathToRegexp(pattern, [], { end: false });
    if (reg.global) reg.lastIndex = 0;
    return ctx => reg.test(ctx.path);
  }
  if (pattern instanceof RegExp) {
    return ctx => {
      if (pattern.global) pattern.lastIndex = 0;
      return pattern.test(ctx.path);
    };
  }
  if (typeof pattern === 'function') return pattern;
  if (Array.isArray(pattern)) {
    const matchs = pattern.map(item => toPathMatch(item));
    return ctx => matchs.some(match => match(ctx));
  }
  throw new MidwayCommonError(
    'match/ignore pattern must be RegExp, Array or String, but got ' + pattern
  );
}