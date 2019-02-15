import { GraphQLSchema } from "graphql";
import * as apolloServer from "apollo-server-koa";
import * as KoaRouter from "koa-router";
import * as koaBody from "koa-bodyparser";

export function createGraphQlKoaRouter(schema: GraphQLSchema): KoaRouter {
  const koaGraphQlOptionsFunction = getKoaGraphQLOptionsFunction(schema);
  const gqlKoaRouter = new KoaRouter();
  gqlKoaRouter.post(this.graphQlConfig.endpoint, koaBody(), enforceOriginMatch, setCacheHeaders, apolloServer.graphqlKoa(koaGraphQlOptionsFunction));
  gqlKoaRouter.get(this.graphQlConfig.endpoint, enforceOriginMatch, setCacheHeaders, apolloServer.graphqlKoa(koaGraphQlOptionsFunction));
  if (this.graphQlConfig.graphiQlEndpointActive === true) {
    gqlKoaRouter.get(this.graphQlConfig.graphiQlEndpoint, apolloServer.graphiqlKoa({ endpointURL: this.graphQlConfig.endpoint }));
  }
  return gqlKoaRouter;
}

async function setCacheHeaders(ctx: any, next: () => any) {
  await next();
  let cacheHeader = "no-store";
  if (ctx.state.includesMutation === true) {
    cacheHeader = "no-store";
  } else {
    if (ctx.state.authRequired === true) {
      cacheHeader = "privat, max-age=600";
    } else {
      cacheHeader = "public, max-age=600";
    }
  }

  ctx.set("Cache-Control", cacheHeader);
}

function enforceOriginMatch(ctx: any, next: () => any) {
  const errorMessage = "All graphql endpoints only allow requests with origin and referrer headers or API-Client requests from non-browsers.";

  if (ctx.securityContext == null) {
    return ctx.throw(400, errorMessage);
  }

  // If a user is requesting data through an API-Client (not a Browser) simply allow everything
  if (ctx.securityContext.isApiClient === true) {
    return next();
  }

  if (ctx.securityContext.sameOriginApproved.byOrigin === true && ctx.securityContext.sameOriginApproved.byReferrer === true) {
    return next();
  }

  return ctx.throw(400, errorMessage);
}

function getKoaGraphQLOptionsFunction(schema: GraphQLSchema): apolloServer.KoaGraphQLOptionsFunction {
  return (ctx) => {
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
}
