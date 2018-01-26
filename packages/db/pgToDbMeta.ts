import * as deepmerge from 'deepmerge';

import * as F1 from '../core';
import { IDbMeta, IDbRelation } from '../core/IDbMeta';

// https://www.alberton.info/postgresql_meta_info.html
export class PgToDbMeta extends F1.AbstractPackage {

  private readonly DELETED_PREFIX = '_deleted:';
  private dbClient = this.$one.getDbSetupClient();
  private readonly dbMeta: IDbMeta = {
    version: 1.0,
    schemas: {},
    enums: {},
    relations: {}
  };

  constructor() {
    super();

  }

  public async getPgDbMeta(): Promise<IDbMeta> {
    try {

      await this.iterateAndAddSchemas();
      // return copy instead of ref
      return deepmerge({}, this.dbMeta);
    } catch (err) {
      throw err;
    }
  }

  // PRIVATE METHODS
  private async iterateAndAddSchemas(): Promise<void> {

    try {
      const { rows } = await this.dbClient.query(
        `SELECT
          schema_name
        FROM
          information_schema.schemata
        WHERE
            schema_name <> '_meta'
          AND
            schema_name <> 'information_schema'
          AND
          schema_name NOT LIKE 'pg_%';`
      );
      // iterate all tables
      for (const row of Object.values(rows)) {
        const schemaName = row.schema_name;

        // ignore deleted schemas
        if (schemaName.indexOf(this.DELETED_PREFIX) !== 0) {
          // getSqlFromMigrationObj schema objects for each schema
          this.dbMeta.schemas[schemaName] = {
            name: schemaName,
            tables: {},
            views: []
          };

          // iterate enum types
          await this.iterateEnumTypes(schemaName);
          // iterate tables
          await this.iterateAndAddTables(schemaName);
        }
      }

    } catch (err) {
      throw err;
    }

  }

  private async iterateEnumTypes(schemaName): Promise<void> {
    // iterate ENUM Types with columns its used in
    const { rows } =  await this.dbClient.query(
      `SELECT
        n.nspname as enum_schema,
        t.typname as enum_name,
        array_to_json(array_agg(e.enumlabel)) as enum_values,
        c.table_schema as used_schema,
        c.table_name as used_table,
        c.column_name as used_column
      FROM
        pg_type t
      JOIN
        pg_enum e on t.oid = e.enumtypid
      JOIN
        pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      FULL JOIN
       information_schema.columns c ON c.udt_name = t.typname
      WHERE
        n.nspname = $1
      GROUP BY
        n.nspname, t.typname, c.table_schema, c.table_name, c.column_name;`, [schemaName]);

    // iterate all tables
    for (const row of Object.values(rows)) {
      const enumName = row.enum_name;

      // reuse existing enum (for multiple columns using same enum)
      const thisEnums = this.dbMeta.enums[enumName] = this.dbMeta.enums[enumName] || {
        name: enumName,
        values: row.enum_values,
        columns: {}
      };
      // add column to enum if used
      if (row.used_schema != null && row.used_table != null && row.used_column != null) {
        const enumColumnName = `${row.used_schema}.${row.used_table}.${row.used_column}`;
        thisEnums.columns[enumColumnName] = {
          schemaName: row.used_schema,
          tableName:  row.used_table,
          columnName: row.used_column
        };
      }
    }
  }

  private async iterateAndAddTables(schemaName): Promise<void> {

    try {
      const { rows } = await this.dbClient.query(
        `SELECT
            table_name
        FROM
          information_schema.tables
        WHERE
          table_schema ='${schemaName}' AND table_type='BASE TABLE';`
      );
      // iterate all tables
      for (const row of Object.values(rows)) {
        const tableName = row.table_name;

        // getSqlFromMigrationObj new table object
        this.dbMeta.schemas[schemaName].tables[tableName] = {
          name: tableName,
          schemaName,
          description: null,
          constraints: {},
          columns: {}
        };

      }

      // iterate tables and add columns - relates on tables existing
      for (const tableName of Object.keys(this.dbMeta.schemas[schemaName].tables)) {
        // add columns to table
        await this.iterateAndAddColumns(schemaName, tableName);
      }

      // iterate tables and add constraints - relates on tables and columns existing
      for (const tableName of Object.keys(this.dbMeta.schemas[schemaName].tables)) {
        // add constraints to table
        await this.iterateAndAddConstraints(schemaName, tableName);
      }

    } catch (err) {
      throw err;
    }

  }

  private async iterateAndAddColumns(schemaName, tableName): Promise<void> {

    // keep reference to current table
    const currentTable = this.dbMeta.schemas[schemaName].tables[tableName];

    try {

      const { rows } = await this.dbClient.query(
        `SELECT
        c.column_name AS column_name,
        c.column_default AS column_default,
        c.is_nullable AS is_nullable,
        c.data_type AS data_type,
        c.udt_name AS udt_name,
        c.character_maximum_length AS character_maximum_length,
        pgd.description AS comment
      FROM
        information_schema.columns c
      LEFT JOIN
	      pg_catalog.pg_description pgd
	    ON
	      pgd.objsubid = c.ordinal_position
      WHERE
        table_schema = $1
        AND
        table_name = $2
      ORDER BY
        ordinal_position ASC;`,[schemaName, tableName]
      );

      // iterate all columns
      for (const column of Object.values(rows)) {
        const type = column.udt_name;

        // getSqlFromMigrationObj new column and keep reference for later
        const columnName = column.column_name;
        const newColumn: any = {
          name: columnName,
          description: null,
          type
        };

        // add new column to dbMeta if its not marked as deleted
        if (columnName.indexOf(this.DELETED_PREFIX) !== 0) {
          currentTable.columns[columnName] = newColumn;
        } else {
          continue;
        }

        // defaut value
        if (column.column_default !== null) {
          const isExpression = (column.column_default.indexOf('::') === -1);
          const value = (isExpression) ? column.column_default : column.column_default.split('::')[0].replace(/'/g,'');
          newColumn.defaultValue = {
            isExpression,
            value
          };
        }

        // add NOT NULLABLE constraint
        if (column.is_nullable === 'NO') {
          this.addConstraint('not_null', { column_name: column.column_name }, currentTable);
        }

        // custom type
        if (column.data_type === 'USER-DEFINED') {
          newColumn.customType = type;
          // check if it is a known enum
          newColumn.type = (this.dbMeta.enums[newColumn.customType] != null) ? 'enum' : 'customType';
        } else if (column.data_type === 'ARRAY' && column.udt_name === '_uuid') { // Array of _uuid is most certainly an n:m relation

          // many to many arrays should have JSON description - check for that
          try {
            const mtmRelationPayload = JSON.parse(column.comment);

            // check if referenced table exists
            if (mtmRelationPayload.reference != null &&
              mtmRelationPayload.reference.tableName != null &&
              this.dbMeta.schemas[mtmRelationPayload.reference.schemaName].tables[mtmRelationPayload.reference.tableName] != null) {
              // getSqlFromMigrationObj one side m:n
              this.manyToManyRelationBuilderHelper(column, schemaName, tableName, mtmRelationPayload);
            }
          } catch (err) {
            process.stderr.write(
              'PgToDbMeta.error.mtmrelation.payload.parsing.error: ' + err + '\n',
            );
          }
        }

      }

    } catch (err) {
      throw err;
    }
  }

  private async iterateAndAddConstraints(schemaName, tableName): Promise<void> {

    // keep reference to current table
    const currentTable = this.dbMeta.schemas[schemaName].tables[tableName];

    // iterate other constraints
    const { rows } = await this.dbClient.query(
      `SELECT
        tc.constraint_type    AS constraint_type,
        tc.constraint_name    AS constraint_name,
        tc.table_schema       AS schema_name,
        tc.table_name         AS table_name,
        kcu.column_name       AS column_name,
        ccu.table_schema      AS references_schema_name,
        ccu.table_name        AS references_table_name,
        ccu.column_name       AS references_column_name,
        rc.update_rule        AS on_update,
        rc.delete_rule        AS on_delete,
        pgc.consrc            AS check_code,
      obj_description(pgc.oid, 'pg_constraint') AS comment
       FROM information_schema.table_constraints tc
  LEFT JOIN information_schema.key_column_usage kcu
         ON tc.constraint_catalog = kcu.constraint_catalog
        AND tc.constraint_schema = kcu.constraint_schema
        AND tc.constraint_name = kcu.constraint_name
  LEFT JOIN information_schema.referential_constraints rc
         ON tc.constraint_catalog = rc.constraint_catalog
        AND tc.constraint_schema = rc.constraint_schema
        AND tc.constraint_name = rc.constraint_name
  LEFT JOIN information_schema.constraint_column_usage ccu
         ON rc.unique_constraint_catalog = ccu.constraint_catalog
        AND rc.unique_constraint_schema = ccu.constraint_schema
        AND rc.unique_constraint_name = ccu.constraint_name
  LEFT JOIN pg_catalog.pg_constraint pgc
       ON pgc.conname = tc.constraint_name
      WHERE tc.table_schema = $1 AND tc.table_name = $2;`, [schemaName, tableName]
    );

    // other constraints
    Object.values(rows).forEach((constraint) => {
      if (constraint.constraint_type === 'FOREIGN KEY') { // relations
        this.relationBuilderHelper(constraint);
      } else if (constraint.constraint_type === 'CHECK') { // checks
        this.addCheck(constraint, currentTable);
      } else { // other constraints
        this.addConstraint(constraint.constraint_type, constraint, currentTable);
      }

    });

  }

  private addConstraint(constraintType,
                        constraintRow,
                        refDbMetaCurrentTable): void {

    let constraintName  = constraintRow.constraint_name;
    const columnName = constraintRow.column_name;
    // ignore constraint if no column name is set
    if (columnName == null) {
      return;
    }

    // add constraint name for not_nullable
    if (constraintType === 'not_null') {
      constraintName = `${refDbMetaCurrentTable.name}_${columnName}_not_null`;
    }

    // getSqlFromMigrationObj new constraint if name was set
    if (constraintName != null) {
      const constraint = refDbMetaCurrentTable.constraints[constraintName] = refDbMetaCurrentTable.constraints[constraintName] || {
        type: constraintType,
        options: {},
        columns: []
      };
      // add column name to constraint - once
      if (constraint.columns.indexOf(columnName) === -1) {
        constraint.columns.push(columnName);
      }
    }

    // add constraint name to field
    const currentColumnRef = refDbMetaCurrentTable.columns[columnName];

    currentColumnRef.constraintNames = currentColumnRef.constraintNames || [];
    currentColumnRef.constraintNames.push(constraintName);
    // keep them sorted for better comparison of objects
    currentColumnRef.constraintNames.sort();

  }

  private addCheck(constraintRow, refDbMetaCurrentTable): void {
    const constraintName = constraintRow.constraint_name;
    const checkCode = constraintRow.check_code;
    // ignore and other constraints without code
    if (checkCode == null) {
      return;
    }

    // getSqlFromMigrationObj new constraint if name was set
    if (constraintName != null) {
      refDbMetaCurrentTable.constraints[constraintName] = refDbMetaCurrentTable.constraints[constraintName] || {
        type: 'CHECK',
        options: {
          param1: checkCode
        }
      };

    }

    // add constraint name to field
    /* const currentColumnRef = refDbMetaCurrentTable.columns[columnName];
		currentColumnRef.constraintNames.push(constraintName);*/
  }

  private relationBuilderHelper(constraint) {

    let relationPayloadOne: any = {};
    let relationPayloadMany: any = {};
    try {
      const relationPayload = Object.values(JSON.parse(constraint.comment));
      relationPayloadOne = relationPayload.find((relation) => {
        return (relation.type === 'ONE');
      });
      relationPayloadMany = relationPayload.find((relation) => {
        return (relation.type === 'MANY');
      });

    } catch (err) {
      // ignore empty payload -> fallback in code below
      process.stderr.write(
        'PgToDbMeta.error.relation.payload.parsing.error: ' + err + '\n',
      );
    }

    const constraintName = relationPayloadOne.name || relationPayloadMany.name || constraint.constraint_name.replace('fk_', '');

    const onUpdate = (constraint.on_update !== 'NO ACTION') ? constraint.on_update : null;
    const onDelete = (constraint.on_delete !== 'NO ACTION') ? constraint.on_delete : null;

    // getSqlFromMigrationObj relation: one
    const relationOne: IDbRelation = {
      name: constraintName,
      type: 'ONE',
      schemaName: constraint.schema_name,
      tableName: constraint.table_name,
      columnName: constraint.column_name,
      virtualColumnName: relationPayloadOne && relationPayloadOne.virtualColumnName,
      onUpdate,
      onDelete,
      // Name of the association
      description: null,
      // joins to
      reference: {
        schemaName: constraint.references_schema_name,
        tableName: constraint.references_table_name,
        columnName: constraint.references_column_name
      }
    };

    // getSqlFromMigrationObj relation: many
    const relationMany: IDbRelation = {
      name: constraintName,
      type: 'MANY',
      schemaName: constraint.references_schema_name,
      tableName: constraint.references_table_name,
      columnName: null,
      virtualColumnName: relationPayloadMany && relationPayloadMany.virtualColumnName,
      onUpdate: null,
      onDelete: null,
      // Name of the association
      description: null,
      // joins to
      reference: {
        schemaName: constraint.schema_name,
        tableName: constraint.table_name,
        columnName: null
      }
    };

    // relations names
    const relationOneName = `${relationOne.schemaName}.${relationOne.tableName}`;
    const relationManyName = `${relationMany.schemaName}.${relationMany.tableName}`;

    // add relation to dbMeta
    this.dbMeta.relations[constraintName] = {
      [relationOneName]: relationOne,
      [relationManyName]: relationMany
    };

    // remove FK column
    delete this.dbMeta.schemas[relationOne.schemaName]
      .tables[relationOne.tableName]
      .columns[this.dbMeta.relations[constraintName][relationOneName].columnName];

  }

  private manyToManyRelationBuilderHelper(columnDescribingRelation, schemaName, tableName, mtmPayload) {

    const relationName = mtmPayload.name;

    // getSqlFromMigrationObj relation: one
    const newRelation: IDbRelation = {
      name: relationName,
      type: 'MANY',
      schemaName,
      tableName,
      columnName: columnDescribingRelation.column_name,
      virtualColumnName: mtmPayload && mtmPayload.virtualColumnName,
      onUpdate: null,
      onDelete: null,
      // Name of the association
      description: null,
      // joins to
      reference: {
        schemaName: mtmPayload.reference.schemaName,
        tableName: mtmPayload.reference.tableName,
        columnName: mtmPayload.reference.columnName
      }
    };

    // relations names
    const relationSideName = `${newRelation.schemaName}.${newRelation.tableName}`;

    // getSqlFromMigrationObj relation object if not available
    this.dbMeta.relations[mtmPayload.name] = this.dbMeta.relations[mtmPayload.name] || {};
    this.dbMeta.relations[mtmPayload.name][relationSideName] = newRelation;

    // remove FK column
    delete this.dbMeta.schemas[newRelation.schemaName].tables[tableName].columns[columnDescribingRelation.column_name];

  }

}
