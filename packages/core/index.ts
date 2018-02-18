// ENV
import * as dotenv from 'dotenv-safe';
// DI
import 'reflect-metadata';
import { Container, Inject, Service } from 'typedi';
export * from 'typedi';

// graceful exit
import * as onExit from 'signal-exit';
import * as terminus from '@godaddy/terminus';
// other npm dependencies
import * as fastGlob from 'fast-glob';
import * as fs from 'fs';
import * as http from 'http';
import * as Koa from 'koa';
import * as _ from 'lodash';
import * as path from 'path';
import { randomBytes } from 'crypto';

// fullstack-one interfaces
import { AbstractPackage } from './AbstractPackage';
export { AbstractPackage };
import { IFullstackOneCore } from './IFullstackOneCore';
import { IConfig } from './IConfigObject';
import { IEnvironment } from './IEnvironment';
import { IDbMeta, IDbRelation } from './IDbMeta';
export { IFullstackOneCore, IEnvironment, IDbMeta, IDbRelation };

// fullstack-one imports
import { helper } from '../helper';
export { helper } from '../helper';
import { EventEmitter } from '../events';
import { DbAppClient, DbGeneralPool, PgClient, PgPool, PgToDbMeta } from '../db';
import { LoggerFactory, ILogger } from '../logger';
import { graphQl } from '../graphQl/index';
import { Migration } from '../migration';
import { Auth } from '../auth';
import { Queue, PgBoss } from '../queue';
import { Email } from '../notifications';
export { LoggerFactory, EventEmitter, ILogger, DbAppClient, DbGeneralPool, IConfig, Queue };

// helper
// import { graphQlHelper } from '../graphQlHelper/main';
// import { getMigrationsUp } from '../graphQlHelper/migration';

// init .env -- check if all are set
try {
  dotenv.config({
    // .env.example is in fullstack-one root folder
    sample: `${__dirname}/../../.env.example`,
  });
} catch (err) {
  process.stderr.write(err.toString() + '\n');
  process.exit(1);
}

@Service()
export class FullstackOneCore extends AbstractPackage implements IFullstackOneCore {

  public readonly ENVIRONMENT: IEnvironment;
  private hasBooted: boolean;

  // dependencies DI
  @Inject()
  private loggerFactory: LoggerFactory;
  private logger: ILogger;

  @Inject()
  private eventEmitter: EventEmitter;

  @Inject()
  private dbAppClientObj: DbAppClient;

  @Inject()
  private dbPoolObj: DbGeneralPool;

  private server: http.Server;
  private APP: Koa;
  private dbMeta: IDbMeta;
  private auth;
  private queue;
  private email;

  constructor() {
    super();

    this.hasBooted = false;

    // load project package.js
    const projectPath = path.dirname(require.main.filename);
    const PROJECT_PACKAGE = require(`${projectPath}/package.json`);

    // ENV CONST
    this.ENVIRONMENT = {
      NODE_ENV: process.env.NODE_ENV,
      name:     PROJECT_PACKAGE.name,
      path:     projectPath,
      port:     parseInt(process.env.PORT, 10),
      version:  PROJECT_PACKAGE.version,
      // getSqlFromMigrationObj unique instance ID (6 char)
      nodeId:   randomBytes(20).toString('hex').substr(5,6),
      namespace:  'one' // default
    };

    // load config
    this.loadConfig();

    // set namespace from config
    this.ENVIRONMENT.namespace = this.getConfig('core').namespace;
    // put ENVIRONMENT into DI
    Container.set('ENVIRONMENT', this.ENVIRONMENT);

    // continue booting async on next tick
    // (is needed in order to be able to call getInstance from outside)
    process.nextTick(() => { this.bootAsync(); });
  }

  /**
   * PUBLIC METHODS
   */
  // return whether server is ready
  get isReady(): boolean {
    return this.hasBooted;
  }

  // return koa app
  get app(): Koa {
    return this.APP;
  }

  // forward GraphQl Schema
  public async getGraphQlSchema() {
    return await graphQl.getGraphQlSchema();
  }

  // forward GraphQl JSON Schema
  public async getGraphQlJsonSchema() {
    return await graphQl.getGraphQlJsonSchema();
  }

  // return DB object
  public getDbMeta(): IDbMeta {
    // return copy instead of ref
    return _.cloneDeep(this.dbMeta);
  }

  public async getMigrationSql() {
    const configDB = this.getConfig('db');
    try {
      const fromDbMeta      = await (new PgToDbMeta()).getPgDbMeta();
      const toDbMeta        = this.getDbMeta();
      const migration       = new Migration(fromDbMeta, toDbMeta);
      return migration.getMigrationSqlStatements(configDB.renameInsteadOfDrop);

    } catch (err) {
      // tslint:disable-next-line:no-console
      console.error('ERROR', err);
    }
  }

  public async runMigration() {

    const configDB = this.getConfig('db');
    try {
      const pgToDbMeta = Container.get(PgToDbMeta);
      const fromDbMeta      = await pgToDbMeta.getPgDbMeta();
      const toDbMeta        = this.getDbMeta();
      const migration       = new Migration(fromDbMeta, toDbMeta);
      return await migration.migrate(configDB.renameInsteadOfDrop);

    } catch (err) {
      // tslint:disable-next-line:no-console
      this.logger.warn('runMigration.error', err);
    }
  }

  /**
   * PRIVATE METHODS
   */

  // boot async and fire event when ready
  private async bootAsync(): Promise<void> {

    try {

      // init core logger
      this.logger = this.getLogger('core');
      this.logger.trace('booting...');

      // connect Db
      await this.connectDB();

      // boot GraphQL and add endpoints
      this.dbMeta = await graphQl.bootGraphQl(this);
      this.emit('dbMeta.set');

      // run auto migration, if enabled
      const configDB = this.getConfig('db');
      if (configDB.automigrate === true) {
        await this.runMigration();
      }

      // start server
      await this.startServer();

      // get Auth from DI
      this.auth = Container.get(Auth);

      // add GraphQL endpoints
      await graphQl.addEndpoints(this);

      // get Queue from DI and init
      const queue = Container.get(Queue);
      this.queue = await queue.start();

      // get Email from DI and init
      this.email = Container.get(Email);

      // send test mail
      await this.email.sendMessage('test@test.de', 'test subject', 'html content');
      // tslint:disable-next-line:no-console
      console.error('***>> sending email');

      // execute book scripts
      await this.executeBootScripts();

      // draw cli
      this.cliArt();

      // emit ready event
      this.hasBooted = true;
      this.emit('ready', this.ENVIRONMENT.nodeId);
    } catch (err) {
      // tslint:disable-next-line:no-console
      console.error('An error occurred while booting', err);
      this.logger.error('An error occurred while booting', err);
      this.emit('not-ready', err);
    }

  }

  private emit(eventName: string, ...args: any[]): void {
    // add namespace
    const eventNamespaceName = `${this.ENVIRONMENT.namespace}.${eventName}`;
    this.eventEmitter.emit(eventNamespaceName, this.ENVIRONMENT.nodeId, ...args);
  }

  private on(eventName: string, listener: (...args: any[]) => void) {
    // add namespace
    const eventNamespaceName = `${this.ENVIRONMENT.namespace}.${eventName}`;
    this.eventEmitter.on(eventNamespaceName, listener);
  }

  // load config based on ENV
  private loadConfig(): void {
    // framework config path
    const frameworkConfigPath = `../../config/default.ts`;

    // project config paths
    const mainConfigPath = `${this.ENVIRONMENT.path}/config/default.ts`;
    const envConfigPath = `${this.ENVIRONMENT.path}/config/${this.ENVIRONMENT.NODE_ENV}.ts`;

    // load framework config file
    let config: IConfig = require(frameworkConfigPath);

    // extend framework config
    // with project config (so it can override framework settings
    if (!!fs.existsSync(mainConfigPath)) {
      config = _.merge(config, require(mainConfigPath));
    }
    // extend with env config
    if (!!fs.existsSync(envConfigPath)) {
      config = _.merge(config, require(envConfigPath));
    }

    // put config into DI
    Container.set('CONFIG', config);
  }

  // connect to setup db and getSqlFromMigrationObj a general connection pool
  private async connectDB() {

    try {
      // create single app client
      await this.dbAppClientObj.connect();
      // managed pool creation will be automatically triggered
      // by the changed number of connected clients

    } catch (err) {
      throw err;
    }

  }

  private async disconnectDB() {

    try {
      // end setup client and pool
      await Promise.all([
          this.dbAppClientObj.end(),
          this.dbPoolObj.end()
        ]);
      return true;
    } catch (err) {
      throw err;
    }

  }

  // execute all boot scripts in the boot folder
  private async executeBootScripts() {
    // get all boot files sync
    const files = fastGlob.sync(`${this.ENVIRONMENT.path}/boot/*.{ts,js}`, {
      deep: true,
      onlyFiles: true,
    });

    // sort files
    files.sort();
    // execute all boot scripts
    for (const file of files) {
      // include all boot files sync
      const bootScript = require(file);
      try {
        bootScript.default != null
          ? await bootScript.default(this)
          : await bootScript(this);
        this.logger.trace('boot script successful', file);
      } catch (err) {
        this.logger.warn('boot script error', file, err);
      }
    }
  }

  private async startServer(): Promise<void> {
    this.APP = new Koa();

    // start KOA on PORT
    this.server = http.createServer(this.APP.callback()).listen(this.ENVIRONMENT.port);

    // register graceful shutdown - terminus
    this.gracefulShutdown();

    // emit event
    this.emit('server.up', this.ENVIRONMENT.port);
    // success log
    this.logger.info('Server listening on port', this.ENVIRONMENT.port);
  }

  private gracefulShutdown() {
    terminus(this.server, {
      // healtcheck options
      healthChecks: {
        // for now we only resolve a promise to make sure the server runs
        '/_health/liveness': () => Promise.resolve(),
        // make sure we are ready to answer requests
        '/_health/readiness': () => getReadyPromise()
      },
      // cleanup options
      timeout: 1000,
      logger: this.logger.info
    });

    // release resources here before node exits
    onExit(async (exitCode, signal) => {

      if (signal) {
        this.logger.info('exiting');

        this.logger.info('starting cleanup');
        this.emit('exiting', this.ENVIRONMENT.nodeId);
        try {

          // close DB connections - has to by synchronous - no await
          // try to exit as many as possible
          this.disconnectDB();

          this.logger.info('shutting down');

          this.emit('down', this.ENVIRONMENT.nodeId);
          return true;
        } catch (err) {

          this.logger.warn('Error occurred during clean up attempt', err);
          this.emit('server.sigterm.error', this.ENVIRONMENT.nodeId, err);
          throw err;
        }
      }
      return false;
    });

  }

  // draw CLI art
  private cliArt(): void {
    process.stdout.write(
      '┌─┐┬ ┬┬  ┬  ┌─┐┌┬┐┌─┐┌─┐┬┌─ ┌─┐┌┐┌┌─┐\n' +
        '├┤ │ ││  │  └─┐ │ ├─┤│  ├┴┐ │ ││││├┤ \n' +
        '└  └─┘┴─┘┴─┘└─┘ ┴ ┴ ┴└─┘┴ ┴o└─┘┘└┘└─┘\n\n',
    );
    process.stdout.write('name: ' + this.ENVIRONMENT.name + '\n');
    process.stdout.write('version: ' + this.ENVIRONMENT.version + '\n');
    process.stdout.write('path: ' + this.ENVIRONMENT.path + '\n');
    process.stdout.write('env: ' + this.ENVIRONMENT.env + '\n');
    process.stdout.write('port: ' + this.ENVIRONMENT.port + '\n');
    process.stdout.write('node id: ' + this.ENVIRONMENT.nodeId + '\n');
    process.stdout.write('____________________________________\n');
  }

}

// GETTER

// ONE SINGLETON
const $one: FullstackOneCore = Container.get(FullstackOneCore);
export function getInstance(): FullstackOneCore {
  return $one;
}

// return finished booting promise
export function getReadyPromise(): Promise<FullstackOneCore> {
  return new Promise(($resolve, $reject) => {

    // already booted?
    if ($one.isReady) {
      $resolve($one);
    } else {

      // catch ready event
      $one.getEventEmitter().on(`${$one.ENVIRONMENT.namespace}.ready`, () => {
        $resolve($one);
      });
      // catch not ready event
      $one.getEventEmitter().on(`${$one.ENVIRONMENT.namespace}.not-ready`, (err) => {
        $reject(err);
      });
    }

  });
}

// helper to convert an event into a promise
export function eventToPromise(pEventName: string): Promise<any> {
  return new Promise(($resolve, $reject) => {
    $one.getEventEmitter().on(pEventName, (...args: any[]) => {
      $resolve([... args]);
    });

  });
}
