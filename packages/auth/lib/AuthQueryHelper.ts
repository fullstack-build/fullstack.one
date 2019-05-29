import { DbGeneralPool, PgClient, PgPoolClient } from "@fullstack-one/db";
import { ILogger } from "@fullstack-one/logger";
import { CryptoFactory } from "./CryptoFactory";
import { SignHelper } from "./SignHelper";

export class AuthQueryHelper {
  private dbGeneralPool: DbGeneralPool;
  private logger: ILogger;
  private authConfig: any;
  private cryptoFactory: CryptoFactory;
  private possibleTransactionIsolationLevels: [string, string, string, string] = [
    "SERIALIZABLE",
    "REPEATABLE READ",
    "READ COMMITTED",
    "READ UNCOMMITTED"
  ];
  private signHelper: SignHelper;

  constructor(dbGeneralPool: DbGeneralPool, logger: ILogger, authConfig: any, cryptoFactory: CryptoFactory, signHelper: SignHelper) {
    this.dbGeneralPool = dbGeneralPool;
    this.authConfig = authConfig;
    this.logger = logger;

    this.cryptoFactory = cryptoFactory;
    this.signHelper = signHelper;
  }

  /* DB HELPER START */
  public async createDbClientAdminTransaction(
    dbClient: PgPoolClient,
    isolationLevel: "SERIALIZABLE" | "REPEATABLE READ" | "READ COMMITTED" | "READ UNCOMMITTED" = "READ COMMITTED"
  ): Promise<PgPoolClient> {
    const isolationLevelIndex = this.possibleTransactionIsolationLevels.findIndex((item) => isolationLevel.toLowerCase() === item.toLowerCase());
    const isolationLevelToUse = this.possibleTransactionIsolationLevels[isolationLevelIndex];

    await dbClient.query(`BEGIN TRANSACTION ISOLATION LEVEL ${isolationLevelToUse};`);
    // set user (admin) for dbClient
    await this.setAdmin(dbClient);
    return dbClient;
  }

  public async createDbClientUserTransaction(
    dbClient: PgPoolClient,
    accessToken: string,
    isolationLevel: "SERIALIZABLE" | "REPEATABLE READ" | "READ COMMITTED" | "READ UNCOMMITTED" = "READ COMMITTED"
  ): Promise<PgPoolClient> {
    const isolationLevelIndex = this.possibleTransactionIsolationLevels.findIndex((item) => isolationLevel.toLowerCase() === item.toLowerCase());
    const isolationLevelToUse = this.possibleTransactionIsolationLevels[isolationLevelIndex];

    await dbClient.query(`BEGIN TRANSACTION ISOLATION LEVEL ${isolationLevelToUse};`);
    // set user for dbClient
    await this.authenticateTransaction(dbClient, accessToken);
    return dbClient;
  }

  public async getCurrentUserIdFromClient(dbClient) {
    return (await dbClient.query("SELECT _auth.current_user_id();")).rows[0].current_user_id;
  }

  public async getCurrentUserIdFromAccessToken(accessToken) {
    return this.userTransaction(accessToken, async (dbClient) => {
      return this.getCurrentUserIdFromClient(dbClient);
    });
  }

  public async adminTransaction(
    callback,
    isolationLevel: "SERIALIZABLE" | "REPEATABLE READ" | "READ COMMITTED" | "READ UNCOMMITTED" = "READ COMMITTED"
  ): Promise<any> {
    const dbClient = await this.dbGeneralPool.pgPool.connect();

    try {
      await this.createDbClientAdminTransaction(dbClient, isolationLevel);

      const result = await callback(dbClient);

      await dbClient.query("COMMIT");
      return result;
    } catch (err) {
      await dbClient.query("ROLLBACK");
      this.logger.warn("adminTransaction.error", err);
      throw err;
    } finally {
      dbClient.release();
    }
  }

  public async adminQuery(...queryArguments: any[]): Promise<any> {
    const dbClient = await this.dbGeneralPool.pgPool.connect();

    try {
      await dbClient.query("BEGIN");

      await this.setAdmin(dbClient);

      const result = await dbClient.query.apply(dbClient, queryArguments);

      await dbClient.query("COMMIT");
      return result;
    } catch (err) {
      await dbClient.query("ROLLBACK");
      this.logger.warn("adminQuery.error", err);
      throw err;
    } finally {
      dbClient.release();
    }
  }

  public async userTransaction(
    accessToken,
    callback,
    isolationLevel: "SERIALIZABLE" | "REPEATABLE READ" | "READ COMMITTED" | "READ UNCOMMITTED" = "READ COMMITTED"
  ): Promise<any> {
    const dbClient = await this.dbGeneralPool.pgPool.connect();

    try {
      await this.createDbClientUserTransaction(dbClient, accessToken, isolationLevel);

      const result = await callback(dbClient);

      await dbClient.query("COMMIT");
      return result;
    } catch (err) {
      await dbClient.query("ROLLBACK");
      this.logger.warn("userTransaction.error", err);
      throw err;
    } finally {
      dbClient.release();
    }
  }

  public async userQuery(accessToken, ...queryArguments: any[]): Promise<any> {
    const dbClient = await this.dbGeneralPool.pgPool.connect();

    try {
      await dbClient.query("BEGIN");

      await this.authenticateTransaction(dbClient, accessToken);

      const result = await dbClient.query.apply(dbClient, queryArguments);

      await dbClient.query("COMMIT");
      return result;
    } catch (err) {
      await dbClient.query("ROLLBACK");
      this.logger.warn("userQuery.error", err);
      throw err;
    } finally {
      dbClient.release();
    }
  }

  public async authenticateTransaction(dbClient, accessToken: string) {
    try {
      const values = [this.cryptoFactory.decrypt(accessToken)];

      await this.setAdmin(dbClient);
      await dbClient.query("SELECT _auth.authenticate_transaction($1);", values);
      await this.unsetAdmin(dbClient);

      return true;
    } catch (err) {
      this.logger.warn("authenticateTransaction.error", err);
      throw err;
    }
  }

  public async setAdmin(dbClient) {
    try {
      await dbClient.query(`SET LOCAL auth.admin_token TO '${this.signHelper.getAdminSignature()}';`);
      return dbClient;
    } catch (err) {
      this.logger.warn("setAdmin.error", err);
      throw err;
    }
  }

  public async unsetAdmin(dbClient) {
    try {
      await dbClient.query("RESET auth.admin_token;");
      return dbClient;
    } catch (err) {
      this.logger.warn("unsetAdmin.error", err);
      throw err;
    }
  }
}
