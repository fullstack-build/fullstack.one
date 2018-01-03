
export default (permissions) => {
  const newPermissions = [];
  const deleteExpressionsByTableName: any = {};

  Object.values(permissions).forEach((permission) => {
    if (permission.type === 'DELETE') {
      if (deleteExpressionsByTableName[permission.table] == null) {
        deleteExpressionsByTableName[permission.table] = {
          gqlTypeName: permission.gqlTypeName,
          expressions: {}
        };
      }
      Object.values(permission.expressions).forEach((expression) => {
        const key = JSON.stringify(expression);
        deleteExpressionsByTableName[permission.table].expressions[key] = expression;
      });
    } else {
      newPermissions.push(permission);
    }
  });

  Object.values(deleteExpressionsByTableName).forEach((value) => {
    const permission = {
      name: 'GeneratedDeleteView',
      type: 'DELETE',
      gqlTypeName: value.gqlTypeName,
      fields: ['id'],
      expressions: []
    };

    Object.values(value.expressions).forEach((expression) => {
      permission.expressions.push(expression);
    });

    newPermissions.push(permission);
  });

  return newPermissions;
};
