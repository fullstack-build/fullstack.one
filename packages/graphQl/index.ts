import { graphiqlKoa, graphqlKoa } from 'apollo-server-koa';
import { makeExecutableSchema } from 'graphql-tools';
import * as koaBody from 'koa-bodyparser';
import * as KoaRouter from 'koa-router';

// fullstack-one core
import * as ONE from '../core';

// import sub modules
import { graphQl as gQLHelper } from './helper';

import { runtimeParser } from './parser';
import { getResolvers } from './queryBuilder/resolvers';

// import interfaces
import { IViews, IExpressions } from './interfaces';
import { parseGraphQlJsonSchemaToDbMeta } from './graphQlSchemaToDbMeta';

export namespace graphQl {

  let gQlSchema: any;
  let gQlJsonSchema: any;
  let views: IViews;
  let expressions: IExpressions;
  let gQlRuntimeSchema: string;
  let gQlRuntimeDocument: any;
  let gQlTypes: any;
  let dbMeta: any;
  let mutations: any;
  let queries: any;
  let customOperations: any;

  // DI
  // todo need refactoring --> ONE.Container.get(ONE.EventEmitter) many times

  export const bootGraphQl = async ($one) => {

    // todo needs refactoring
    const logger = ONE.Container.get(ONE.LoggerFactory).create('bootGraphQl');
    const graphQlConfig = ONE.Container.get(ONE.FullstackOneCore).getConfig('graphql');

    try {

      // load schema
      const gQlSchemaPattern = $one.ENVIRONMENT.path + graphQlConfig.schemaPattern;
      gQlSchema = await ONE.helper.loadFilesByGlobPattern(gQlSchemaPattern);

      const gQlSchemaCombined = gQlSchema.join('\n');
      gQlJsonSchema = gQLHelper.helper.parseGraphQlSchema(gQlSchemaCombined);

      dbMeta = parseGraphQlJsonSchemaToDbMeta(gQlJsonSchema);

      // load permissions and expressions and generate views and put them into schemas
      try {

        // load permissions
        const viewsPattern = $one.ENVIRONMENT.path + graphQlConfig.viewsPattern;
        const viewsArray = await ONE.helper.requireFilesByGlobPattern(viewsPattern);
        views = [].concat.apply([], viewsArray);

        // load expressions
        const expressionsPattern = $one.ENVIRONMENT.path + graphQlConfig.expressionsPattern;
        const expressionsArray = await ONE.helper.requireFilesByGlobPattern(expressionsPattern);
        expressions = [].concat.apply([], expressionsArray);

        const combinedSchemaInformation = runtimeParser(gQlJsonSchema, views, expressions, dbMeta, $one);

        gQlRuntimeDocument = combinedSchemaInformation.document;
        gQlRuntimeSchema = gQLHelper.helper.printGraphQlDocument(gQlRuntimeDocument);
        gQlTypes = combinedSchemaInformation.gQlTypes;
        queries = combinedSchemaInformation.queries;
        mutations = combinedSchemaInformation.mutations;

        customOperations = {
          fields: combinedSchemaInformation.customFields,
          queries: combinedSchemaInformation.customQueries,
          mutations: combinedSchemaInformation.customMutations
        };

        Object.values(combinedSchemaInformation.dbViews).forEach((dbView) => {
          if (dbMeta.schemas[dbView.viewSchemaName] == null) {
            dbMeta.schemas[dbView.viewSchemaName] = {
              tables: {},
              views: {}
            };
          }
          dbMeta.schemas[dbView.viewSchemaName].views[dbView.viewName] = dbView;
        });

      } catch (err) {
        throw err;
      }

      return dbMeta;

    } catch (err) {
      // tslint:disable-next-line:no-console
      console.log('ERR', err);

      logger.warn('bootGraphQl.error', err);
    }

  };

  export const getGraphQlSchema = async () => {
    // return copy insted of ref
    return { ...gQlSchema };
  };

  export const getGraphQlJsonSchema = async () => {
    // return copy insted of ref
    return { ...gQlJsonSchema };
  };

  export const addEndpoints = async ($one) => {
    const graphQlConfig = $one.getConfig('graphql');

    const gqlRouter = new KoaRouter();

    // Load resolvers
    const resolversPattern = $one.ENVIRONMENT.path + graphQlConfig.resolversPattern;
    const resolversObject = await ONE.helper.requireFilesByGlobPatternAsObject(resolversPattern);

    const schema = makeExecutableSchema({
			typeDefs: gQlRuntimeSchema,
			resolvers: getResolvers(gQlTypes, dbMeta, queries, mutations, customOperations, resolversObject),
		});

    const setCacheHeaders = async (ctx, next) => {
      await next();
      let cacheHeader = 'no-store';
      // console.log(ctx.response.body, ctx.response.body != null , typeof ctx.response.body);
      // || (ctx.body != null && ctx.body.errors != null && ctx.body.errors.length > 0)
      if (ctx.state.includesMutation === true) {
        cacheHeader = 'no-store';
      } else {
        if (ctx.state.authRequired === true) {
          cacheHeader = 'privat, max-age=600';
        } else {
          cacheHeader = 'public, max-age=600';
        }
      }

      ctx.set('Cache-Control', cacheHeader);
    };

    const gQlParam = (ctx) => {
      ctx.state.authRequired = false;
      ctx.state.includesMutation = false;

      return {
        schema,
        context: {
          ctx,
          accessToken: ctx.state.accessToken
        }
      };
    };

    // koaBody is needed just for POST.
    gqlRouter.post('/graphql', koaBody(), setCacheHeaders, graphqlKoa(gQlParam));
    gqlRouter.get('/graphql', setCacheHeaders, graphqlKoa(gQlParam));

    gqlRouter.get(graphQlConfig.graphiQlEndpoint, graphiqlKoa({ endpointURL: graphQlConfig.endpoint }));

    $one.app.use(gqlRouter.routes());
    $one.app.use(gqlRouter.allowedMethods());

  };
}
