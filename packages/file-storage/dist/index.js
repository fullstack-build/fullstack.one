"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const di_1 = require("@fullstack-one/di");
const db_1 = require("@fullstack-one/db");
const server_1 = require("@fullstack-one/server");
const boot_loader_1 = require("@fullstack-one/boot-loader");
const config_1 = require("@fullstack-one/config");
const graphql_1 = require("@fullstack-one/graphql");
const auth_1 = require("@fullstack-one/auth");
const schema_builder_1 = require("@fullstack-one/schema-builder");
const logger_1 = require("@fullstack-one/logger");
const KoaRouter = require("koa-router");
const koaBody = require("koa-bodyparser");
const Minio = require("minio");
// import { DbGeneralPool } from '@fullstack-one/db/DbGeneralPool';
const parser_1 = require("./parser");
const defaultVerifier_1 = require("./defaultVerifier");
const fs = require("fs");
// extend migrations
require("./migrationExtension");
const schema = fs.readFileSync(require.resolve('../schema.gql'), 'utf-8');
let FileStorage = class FileStorage {
    constructor(loggerFactory, dbGeneralPool, server, bootLoader, config, graphQl, schemaBuilder, auth) {
        this.verifiers = {};
        // register package config
        config.addConfigFolder(__dirname + '/../config');
        this.logger = loggerFactory.create('AutoMigrate');
        this.server = server;
        this.dbGeneralPool = dbGeneralPool;
        this.graphQl = graphQl;
        this.schemaBuilder = schemaBuilder;
        this.config = config;
        this.auth = auth;
        // add migration path
        this.schemaBuilder.getDbSchemaBuilder().addMigrationPath(__dirname + '/..');
        this.schemaBuilder.extendSchema(schema);
        this.schemaBuilder.addExtension(parser_1.getParser());
        this.graphQl.addResolvers(this.getResolvers());
        this.graphQl.addHook('postMutation', this.postMutationHook.bind(this));
        this.addVerifier('DEFAULT', defaultVerifier_1.defaultVerifier);
        bootLoader.addBootFunction(this.boot.bind(this));
    }
    addVerifier(type, fn) {
        if (this.verifiers[type] == null) {
            this.verifiers[type] = fn;
        }
        else {
            throw new Error(`A verifier for type '${type}' already exists.`);
        }
    }
    boot() {
        return __awaiter(this, void 0, void 0, function* () {
            this.fileStorageConfig = this.config.getConfig('fileStorage');
            this.client = new Minio.Client(this.fileStorageConfig.minio);
            const authRouter = new KoaRouter();
            const app = this.server.getApp();
            authRouter.get('/test', (ctx) => __awaiter(this, void 0, void 0, function* () {
                ctx.body = 'Hallo';
            }));
            authRouter.use(koaBody());
            app.use(authRouter.routes());
            app.use(authRouter.allowedMethods());
        });
    }
    postMutationHook(info, context) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const entityId = info.entityId;
                const result = yield this.auth.adminQuery('SELECT * FROM _meta.file_todelete_by_entity($1);', [entityId]);
                result.rows.forEach((row) => {
                    this.deleteFileAsAdmin(`${row.id}.${row.extension}`);
                });
            }
            catch (e) {
                // I don't care
            }
        });
    }
    presignedPutObject(fileName) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.client.presignedPutObject(this.fileStorageConfig.bucket, fileName, 12 * 60 * 60);
        });
    }
    presignedGetObject(fileName) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.client.presignedGetObject(this.fileStorageConfig.bucket, fileName, 12 * 60 * 60);
        });
    }
    deleteFileAsAdmin(fileName) {
        return __awaiter(this, void 0, void 0, function* () {
            let fileInBucket = false;
            try {
                const stats = yield this.client.statObject(this.fileStorageConfig.bucket, fileName);
                fileInBucket = true;
            }
            catch (e) {
                // The file has never been created.
            }
            try {
                yield this.auth.adminTransaction((client) => __awaiter(this, void 0, void 0, function* () {
                    const fileId = fileName.split('.')[0];
                    const result = yield client.query('SELECT * FROM _meta.file_deleteone_admin($1);', [fileId]);
                    if (result.rows.length < 1) {
                        throw new Error("Failed to delete file 'fileId' from db.");
                    }
                    if (fileInBucket === true) {
                        yield this.client.removeObject(this.fileStorageConfig.bucket, fileName);
                    }
                }));
            }
            catch (e) {
                this.logger.warn('deleteFileAsAdmin.error', `Failed to delete file '${fileName}'.`, e);
                // I don't care => File will be deleted by a cleanup-script some time
                return;
            }
        });
    }
    deleteFile(fileName, context) {
        return __awaiter(this, void 0, void 0, function* () {
            let fileInBucket = false;
            try {
                const stats = yield this.client.statObject(this.fileStorageConfig.bucket, fileName);
                fileInBucket = true;
            }
            catch (e) {
                // The file has never been created.
            }
            try {
                yield this.auth.userTransaction(context.accessToken, (client) => __awaiter(this, void 0, void 0, function* () {
                    const fileId = fileName.split('.')[0];
                    yield client.query('SELECT * FROM _meta.file_deleteone($1);', [fileId]);
                    if (fileInBucket === true) {
                        yield this.client.removeObject(this.fileStorageConfig.bucket, fileName);
                    }
                }));
            }
            catch (e) {
                this.logger.warn('deleteFile.error', `Failed to delete file '${fileName}'.`, e);
                // I don't care => File will be deleted by a cleanup-script some time
                return;
            }
        });
    }
    getResolvers() {
        return {
            '@fullstack-one/file-storage/createFile': (obj, args, context, info, params) => __awaiter(this, void 0, void 0, function* () {
                const extension = args.extension.toLowerCase();
                const type = args.type || 'DEFAULT';
                if (this.verifiers[type] == null) {
                    throw new Error(`A verifier for type '${type}' hasn't been defined.`);
                }
                const result = yield this.auth.userQuery(context.accessToken, 'SELECT _meta.file_create($1, $2) AS "fileId";', [extension, type]);
                const fileId = result.rows[0].fileId;
                const fileName = `${fileId}.${extension}`;
                const uploadFileName = `${fileId}_upload.${extension}`;
                const presignedPutUrl = yield this.presignedPutObject(uploadFileName);
                return {
                    extension,
                    type,
                    fileName,
                    uploadFileName,
                    presignedPutUrl
                };
            }),
            '@fullstack-one/file-storage/verifyFile': (obj, args, context, info, params) => __awaiter(this, void 0, void 0, function* () {
                const fileName = args.fileName;
                const fileId = fileName.split('.')[0];
                const extension = fileName.split('.')[1];
                const uploadFileName = `${fileId}_upload.${extension}`;
                const result = yield this.auth.userQuery(context.accessToken, 'SELECT _meta.file_get_type_to_verify($1) AS "type";', [fileId]);
                const type = result.rows[0].type;
                let stat = null;
                if (this.verifiers[type] == null) {
                    throw new Error(`A verifier for type '${type}' hasn't been defined.`);
                }
                try {
                    stat = yield this.client.statObject(this.fileStorageConfig.bucket, uploadFileName);
                }
                catch (e) {
                    if (e.message.toLowerCase().indexOf('not found') >= 0) {
                        throw new Error('Please upload a file before verifying.');
                    }
                    throw e;
                }
                const verifyFileName = `${fileId}_temp_${Date.now()}_${Math.round(Math.random() * 100000000000)}.${extension}`;
                const verifyCopyConditions = new Minio.CopyConditions();
                verifyCopyConditions.setMatchETag(stat.etag);
                yield this.client.copyObject(this.fileStorageConfig.bucket, uploadFileName, `/${this.fileStorageConfig.bucket}/${verifyFileName}`, verifyCopyConditions);
                const ctx = {
                    client: this.client,
                    fileName,
                    verifyFileName,
                    uploadFileName,
                    bucket: this.fileStorageConfig.bucket
                };
                const etag = yield this.verifiers[type](ctx);
                const finalCopyConditions = new Minio.CopyConditions();
                finalCopyConditions.setMatchETag(etag);
                yield this.client.copyObject(this.fileStorageConfig.bucket, verifyFileName, `/${this.fileStorageConfig.bucket}/${fileName}`, finalCopyConditions);
                yield this.auth.userQuery(context.accessToken, 'SELECT _meta.file_verify($1);', [fileId]);
                const presignedGetUrl = yield this.presignedGetObject(fileName);
                return {
                    fileName,
                    presignedGetUrl
                };
            }),
            '@fullstack-one/file-storage/clearUpFiles': (obj, args, context, info, params) => __awaiter(this, void 0, void 0, function* () {
                let result;
                if (args.fileName != null) {
                    const fileId = args.fileName.split('.')[0];
                    result = yield this.auth.userQuery(context.accessToken, 'SELECT * FROM _meta.file_clearupone($1);', [fileId]);
                }
                else {
                    result = yield this.auth.userQuery(context.accessToken, 'SELECT * FROM _meta.file_clearup();');
                }
                const filesDeleted = result.rows.map(row => `${row.id}.${row.extension}`);
                filesDeleted.forEach((fileName) => {
                    this.deleteFile(fileName, context);
                });
                return filesDeleted;
            }),
            '@fullstack-one/file-storage/readFiles': (obj, args, context, info, params) => __awaiter(this, void 0, void 0, function* () {
                const awaitingFileSignatures = [];
                if (obj[info.fieldName] == null) {
                    return [];
                }
                const data = obj[info.fieldName];
                for (const fileName of data) {
                    try {
                        awaitingFileSignatures.push({
                            fileName,
                            presignedGetUrlPromise: this.presignedGetObject(fileName)
                        });
                    }
                    catch (err) {
                        // Errors can be ignored => Failed Signs are not returned
                        this.logger.warn('readFiles.signFail', err);
                    }
                }
                const results = [];
                for (const fileObject of awaitingFileSignatures) {
                    try {
                        const presignedGetUrl = yield fileObject.presignedGetUrlPromise;
                        const fileName = fileObject.fileName;
                        results.push({
                            fileName,
                            presignedGetUrl
                        });
                    }
                    catch (err) {
                        // Errors can be ignored => Failed Signs are not returned
                        this.logger.warn('readFiles.signFail.promise', err);
                    }
                }
                return results;
            })
        };
    }
};
FileStorage = __decorate([
    di_1.Service(),
    __param(0, di_1.Inject(type => logger_1.LoggerFactory)),
    __param(1, di_1.Inject(type => db_1.DbGeneralPool)),
    __param(2, di_1.Inject(type => server_1.Server)),
    __param(3, di_1.Inject(type => boot_loader_1.BootLoader)),
    __param(4, di_1.Inject(type => config_1.Config)),
    __param(5, di_1.Inject(type => graphql_1.GraphQl)),
    __param(6, di_1.Inject(type => schema_builder_1.SchemaBuilder)),
    __param(7, di_1.Inject(type => auth_1.Auth)),
    __metadata("design:paramtypes", [typeof (_a = typeof logger_1.LoggerFactory !== "undefined" && logger_1.LoggerFactory) === "function" && _a || Object, Object, Object, Object, Object, Object, Object, Object])
], FileStorage);
exports.FileStorage = FileStorage;
var _a;
