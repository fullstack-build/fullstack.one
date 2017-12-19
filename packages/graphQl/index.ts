import { graphiqlKoa, graphqlKoa } from 'apollo-server-koa';
import { makeExecutableSchema } from 'graphql-tools';
import * as koaBody from 'koa-bodyparser';
import * as KoaRouter from 'koa-router';

// fullstack-one core
import { helper } from '../core';

// import sub modules
import { graphQl as gQLHelper } from './helper';
export * from '../migration/migration';

import { runtimeParser } from './parser';
import { getResolvers } from './queryBuilder/resolvers';

// import interfaces
import { IPermissions, IExpressions } from './interfaces';
import { parseGraphQlJsonSchemaToDbObject } from './graphQlSchemaToDbObject';

export namespace graphQl {

  let gQlSchema: any;
  let gQlJsonSchema: any;
  let permissions: IPermissions;
  let expressions: IExpressions;
  let gQlRuntimeSchema: string;
  let gQlRuntimeDocument: any;
  let gQlTypes: any;
  let dbObject: any;
  let mutations: any;
  let queries: any;

  export const bootGraphQl = async ($one) => {

    const logger = $one.getLogger('bootGraphQl');
    const graphQlConfig = $one.getConfig('graphql');

    try {

      // load schema
      const gQlSchemaPattern = $one.ENVIRONMENT.path + graphQlConfig.schemaPattern;
      gQlSchema = await helper.loadFilesByGlobPattern(gQlSchemaPattern);
      // emit event
      $one.getEventEmitter().emit(`${$one.ENVIRONMENT.namespace}.graphQl.schema.load.success`);

      const gQlSchemaCombined = gQlSchema.join('\n');
      gQlJsonSchema = gQLHelper.helper.parseGraphQlSchema(gQlSchemaCombined);
      // emit event
      $one.getEventEmitter().emit(`${$one.ENVIRONMENT.namespace}.graphQl.schema.parsed`);

      dbObject = parseGraphQlJsonSchemaToDbObject(gQlJsonSchema);
      // emit event
      $one.getEventEmitter().emit(`${$one.ENVIRONMENT.namespace}.graphQl.schema.parsed.to.dbObject`);

      // load permissions
      const permissionsPattern = $one.ENVIRONMENT.path + graphQlConfig.permissionsPattern;
      const permissionsArray = await helper.requireFilesByGlobPattern(permissionsPattern);
      permissions = [].concat.apply([], permissionsArray);
      // emit event
      $one.getEventEmitter().emit(`${$one.ENVIRONMENT.namespace}.graphQl.permissions.load.success`);

      // load expressions
      const expressionsPattern = $one.ENVIRONMENT.path + graphQlConfig.expressionsPattern;
      const expressionsArray = await helper.requireFilesByGlobPattern(expressionsPattern);
      expressions = [].concat.apply([], expressionsArray);
      // emit event
      $one.getEventEmitter().emit(`${$one.ENVIRONMENT.namespace}.graphQl.expressions.load.success`);

      const combinedSchemaInformation = runtimeParser(gQlJsonSchema, permissions, expressions);

      gQlRuntimeDocument = combinedSchemaInformation.document;
      gQlRuntimeSchema = gQLHelper.helper.printGraphQlDocument(gQlRuntimeDocument);
      gQlTypes = combinedSchemaInformation.gQlTypes;
      queries = combinedSchemaInformation.queries;
      mutations = combinedSchemaInformation.mutations;

      dbObject.views = combinedSchemaInformation.views;

      // add endpoints
      addEndpoints($one);

      return dbObject;

    } catch (err) {
      // tslint:disable-next-line:no-console
      console.log('ERR', err);

      logger.warn('bootGraphQl.error', err);
      // emit event
      $one.getEventEmitter().emit(`${$one.ENVIRONMENT.namespace}.graphQl.bootGraphQl.error`, err);
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

  const addEndpoints = ($one) => {
    const graphQlConfig = $one.getConfig('graphql');

    const gqlRouter = new KoaRouter();

    const schema = makeExecutableSchema({
			typeDefs: gQlRuntimeSchema,
			resolvers: getResolvers(gQlTypes, dbObject, queries, mutations),
		});

    const gQlParam = (ctx) => {

      const userId = ctx.cookies.get('userId', { signed: false }) || 0;

      return {
        schema,
        context: {
          userId
        }
      };
    };

    // koaBody is needed just for POST.
    gqlRouter.post('/graphql', koaBody(), graphqlKoa(gQlParam));
    gqlRouter.get('/graphql', graphqlKoa(gQlParam));

    gqlRouter.get(graphQlConfig.graphiQlEndpoint, graphiqlKoa({ endpointURL: graphQlConfig.endpoint }));

    $one.getApp().use(gqlRouter.routes());
    $one.getApp().use(gqlRouter.allowedMethods());

  };
}

/*
const generatedTestSchema = `

type User_Author @view {
  id: ID! @isUnique
  firstLetterOfUserName: String @computed(expression: "FirstNofField", params: {n: 1})
}

type User_Me @view {
  id: ID! @isUnique
  email: String @isUnique
  username: String
}

type User_Fusion @viewfusion {
  id: ID! @isUnique
  email: String @isUnique
  username: String
  firstLetterOfUserName: String @computed(expression: "FirstNofField", params: {n: 1})
}

union User = User_Author | User_Me | User_Fusion

schema {
  query: RootQuery
}

type RootQuery {
  users(sql: String): [User!]!
}
`;

const testResolvers = {
  RootQuery: {
    users: (obj, args, context, info) => {
      console.log(JSON.stringify(info, null, 2));

      // return [{id:13, firstLetterOfUserName: 'A'}];
      return [{ id: 12, email: 'dustin@fullstack.build', __type: 'User_Me' },{ id:13, firstLetterOfUserName: 'A', __type: 'User_Author' }];
    },
  },
  User_Me: {

  },
  User_Author: {
    // firstLetterOfUserName: () => {
    //  return 'B'
    // }
  },
  User_Fusion: {

  },
  User: {
    __resolveType(obj, context, info) {
      return obj.__type;
      // console.log(obj);

      /*if(obj.firstLetterOfUserName){
        return 'User_Author';
      }
      return 'User_Me';

      if(obj.email && obj.username){
        return 'User_Fusion';
      }

      if(obj.email){
        return 'User_Me';
      }

      return 'User_Fusion';* /
    },
  },
};

*/
