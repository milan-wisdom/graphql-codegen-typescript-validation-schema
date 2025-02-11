import { transformSchemaAST } from '@graphql-codegen/schema-ast';
import { buildSchema, printSchema, visit } from 'graphql';
import { isGeneratedByIntrospection, topologicalSortAST } from './graphql';
import { MyZodSchemaVisitor } from './myzod/index';
import { YupSchemaVisitor } from './yup/index';
import { ZodSchemaVisitor } from './zod/index';
export const plugin = (schema, _documents, config) => {
    const { schema: _schema, ast } = _transformSchemaAST(schema, config);
    const visitor = schemaVisitor(_schema, config);
    const result = visit(ast, visitor);
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const generated = result.definitions.filter(def => typeof def === 'string');
    return {
        prepend: visitor.buildImports(),
        content: [visitor.initialEmit(), ...generated].join('\n'),
    };
};
const schemaVisitor = (schema, config) => {
    if (config?.schema === 'zod') {
        return new ZodSchemaVisitor(schema, config);
    }
    else if (config?.schema === 'myzod') {
        return new MyZodSchemaVisitor(schema, config);
    }
    return new YupSchemaVisitor(schema, config);
};
const _transformSchemaAST = (schema, config) => {
    const { schema: _schema, ast } = transformSchemaAST(schema, config);
    // See: https://github.com/Code-Hex/graphql-codegen-typescript-validation-schema/issues/394
    const __schema = isGeneratedByIntrospection(_schema) ? buildSchema(printSchema(_schema)) : _schema;
    // This affects the performance of code generation, so it is
    // enabled only when this option is selected.
    if (config.validationSchemaExportType === 'const') {
        return {
            schema: __schema,
            ast: topologicalSortAST(__schema, ast),
        };
    }
    return {
        schema: __schema,
        ast,
    };
};
