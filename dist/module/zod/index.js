import { DeclarationBlock, indent } from '@graphql-codegen/visitor-plugin-common';
import { Kind, } from 'graphql';
import { buildApi, formatDirectiveConfig } from '../directive';
import { BaseSchemaVisitor } from '../schema_visitor';
import { isInput, isListType, isNamedType, isNonNullType, ObjectTypeDefinitionBuilder } from './../graphql';
const anySchema = `definedNonNullAnySchema`;
export class ZodSchemaVisitor extends BaseSchemaVisitor {
    constructor(schema, config) {
        super(schema, config);
    }
    importValidationSchema() {
        return `import { z } from 'zod'`;
    }
    initialEmit() {
        return ('\n' +
            [
                new DeclarationBlock({})
                    .asKind('type')
                    .withName('Properties<T>')
                    .withContent(['Required<{', '  [K in keyof T]: z.ZodType<T[K], any, T[K]>;', '}>'].join('\n')).string,
                // Unfortunately, zod doesn’t provide non-null defined any schema.
                // This is a temporary hack until it is fixed.
                // see: https://github.com/colinhacks/zod/issues/884
                new DeclarationBlock({}).asKind('type').withName('definedNonNullAny').withContent('{}').string,
                new DeclarationBlock({})
                    .export()
                    .asKind('const')
                    .withName(`isDefinedNonNullAny`)
                    .withContent(`(v: any): v is definedNonNullAny => v !== undefined && v !== null`).string,
                new DeclarationBlock({})
                    .export()
                    .asKind('const')
                    .withName(`${anySchema}`)
                    .withContent(`z.any().refine((v) => isDefinedNonNullAny(v))`).string,
                ...this.enumDeclarations,
            ].join('\n'));
    }
    get InputObjectTypeDefinition() {
        return {
            leave: (node) => {
                const visitor = this.createVisitor('input');
                const name = visitor.convertName(node.name.value);
                this.importTypes.push(name);
                return this.buildInputFields(node.fields ?? [], visitor, name);
            },
        };
    }
    get ObjectTypeDefinition() {
        return {
            leave: ObjectTypeDefinitionBuilder(this.config.withObjectType, (node) => {
                const visitor = this.createVisitor('output');
                const name = visitor.convertName(node.name.value);
                this.importTypes.push(name);
                // Building schema for field arguments.
                const argumentBlocks = this.buildObjectTypeDefinitionArguments(node, visitor);
                const appendArguments = argumentBlocks ? '\n' + argumentBlocks : '';
                // Building schema for fields.
                const shape = node.fields?.map(field => generateFieldZodSchema(this.config, visitor, field, 2)).join(',\n');
                switch (this.config.validationSchemaExportType) {
                    case 'const':
                        return (new DeclarationBlock({})
                            .export()
                            .asKind('const')
                            .withName(`${name}Schema: z.ZodObject<Properties<${name}>>`)
                            .withContent([
                            `z.object({`,
                            indent(`__typename: z.literal('${node.name.value}').optional(),`, 2),
                            shape,
                            '})',
                        ].join('\n')).string + appendArguments);
                    case 'function':
                    default:
                        return (new DeclarationBlock({})
                            .export()
                            .asKind('function')
                            .withName(`${name}Schema(): z.ZodObject<Properties<${name}>>`)
                            .withBlock([
                            indent(`return z.object({`),
                            indent(`__typename: z.literal('${node.name.value}').optional(),`, 2),
                            shape,
                            indent('})'),
                        ].join('\n')).string + appendArguments);
                }
            }),
        };
    }
    get EnumTypeDefinition() {
        return {
            leave: (node) => {
                const visitor = this.createVisitor('both');
                const enumname = visitor.convertName(node.name.value);
                this.importTypes.push(enumname);
                // hoist enum declarations
                this.enumDeclarations.push(this.config.enumsAsTypes
                    ? new DeclarationBlock({})
                        .export()
                        .asKind('const')
                        .withName(`${enumname}Schema`)
                        .withContent(`z.enum([${node.values?.map(enumOption => `'${enumOption.name.value}'`).join(', ')}])`)
                        .string
                    : new DeclarationBlock({})
                        .export()
                        .asKind('const')
                        .withName(`${enumname}Schema`)
                        .withContent(`z.nativeEnum(${enumname})`).string);
            },
        };
    }
    get UnionTypeDefinition() {
        return {
            leave: (node) => {
                if (!node.types || !this.config.withObjectType)
                    return;
                const visitor = this.createVisitor('output');
                const unionName = visitor.convertName(node.name.value);
                const unionElements = node.types
                    .map(t => {
                    const element = visitor.convertName(t.name.value);
                    const typ = visitor.getType(t.name.value);
                    if (typ?.astNode?.kind === 'EnumTypeDefinition') {
                        return `${element}Schema`;
                    }
                    switch (this.config.validationSchemaExportType) {
                        case 'const':
                            return `${element}Schema`;
                        case 'function':
                        default:
                            return `${element}Schema()`;
                    }
                })
                    .join(', ');
                const unionElementsCount = node.types.length ?? 0;
                const union = unionElementsCount > 1 ? `z.union([${unionElements}])` : unionElements;
                switch (this.config.validationSchemaExportType) {
                    case 'const':
                        return new DeclarationBlock({}).export().asKind('const').withName(`${unionName}Schema`).withContent(union)
                            .string;
                    case 'function':
                    default:
                        return new DeclarationBlock({})
                            .export()
                            .asKind('function')
                            .withName(`${unionName}Schema()`)
                            .withBlock(indent(`return ${union}`)).string;
                }
            },
        };
    }
    buildInputFields(fields, visitor, name) {
        const shape = fields.map(field => generateFieldZodSchema(this.config, visitor, field, 2)).join(',\n');
        switch (this.config.validationSchemaExportType) {
            case 'const':
                return new DeclarationBlock({})
                    .export()
                    .asKind('const')
                    .withName(`${name}Schema: z.ZodObject<Properties<${name}>>`)
                    .withContent(['z.object({', shape, '})'].join('\n')).string;
            case 'function':
            default:
                return new DeclarationBlock({})
                    .export()
                    .asKind('function')
                    .withName(`${name}Schema(): z.ZodObject<Properties<${name}>>`)
                    .withBlock([indent(`return z.object({`), shape, indent('})')].join('\n')).string;
        }
    }
}
const generateFieldZodSchema = (config, visitor, field, indentCount) => {
    const gen = generateFieldTypeZodSchema(config, visitor, field, field.type);
    return indent(`${field.name.value}: ${maybeLazy(field.type, gen)}`, indentCount);
};
const generateFieldTypeZodSchema = (config, visitor, field, type, parentType) => {
    if (isListType(type)) {
        const gen = generateFieldTypeZodSchema(config, visitor, field, type.type, type);
        if (!isNonNullType(parentType)) {
            const arrayGen = `z.array(${maybeLazy(type.type, gen)})`;
            const maybeLazyGen = applyDirectives(config, field, arrayGen);
            return `${maybeLazyGen}.nullish()`;
        }
        return `z.array(${maybeLazy(type.type, gen)})`;
    }
    if (isNonNullType(type)) {
        const gen = generateFieldTypeZodSchema(config, visitor, field, type.type, type);
        return maybeLazy(type.type, gen);
    }
    if (isNamedType(type)) {
        const gen = generateNameNodeZodSchema(config, visitor, type.name);
        if (isListType(parentType)) {
            return `${gen}.nullable()`;
        }
        let appliedDirectivesGen = applyDirectives(config, field, gen);
        if (field.kind === Kind.INPUT_VALUE_DEFINITION) {
            const { defaultValue } = field;
            if (defaultValue?.kind === Kind.INT || defaultValue?.kind === Kind.FLOAT || defaultValue?.kind === Kind.BOOLEAN) {
                appliedDirectivesGen = `${appliedDirectivesGen}.default(${defaultValue.value})`;
            }
            if (defaultValue?.kind === Kind.STRING || defaultValue?.kind === Kind.ENUM) {
                appliedDirectivesGen = `${appliedDirectivesGen}.default("${defaultValue.value}")`;
            }
        }
        if (isNonNullType(parentType)) {
            if (visitor.shouldEmitAsNotAllowEmptyString(type.name.value)) {
                return `${appliedDirectivesGen}.min(1)`;
            }
            return appliedDirectivesGen;
        }
        if (isListType(parentType)) {
            return `${appliedDirectivesGen}.nullable()`;
        }
        return `${appliedDirectivesGen}.nullish()`;
    }
    console.warn('unhandled type:', type);
    return '';
};
const applyDirectives = (config, field, gen) => {
    if (config.directives && field.directives) {
        const formatted = formatDirectiveConfig(config.directives);
        return gen + buildApi(formatted, field.directives);
    }
    return gen;
};
const generateNameNodeZodSchema = (config, visitor, node) => {
    const converter = visitor.getNameNodeConverter(node);
    switch (converter?.targetKind) {
        case 'InputObjectTypeDefinition':
        case 'ObjectTypeDefinition':
        case 'UnionTypeDefinition':
            // using switch-case rather than if-else to allow for future expansion
            switch (config.validationSchemaExportType) {
                case 'const':
                    return `${converter.convertName()}Schema`;
                case 'function':
                default:
                    return `${converter.convertName()}Schema()`;
            }
        case 'EnumTypeDefinition':
            return `${converter.convertName()}Schema`;
        default:
            return zod4Scalar(config, visitor, node.value);
    }
};
const maybeLazy = (type, schema) => {
    if (isNamedType(type) && isInput(type.name.value)) {
        return `z.lazy(() => ${schema})`;
    }
    return schema;
};
const zod4Scalar = (config, visitor, scalarName) => {
    if (config.scalarSchemas?.[scalarName]) {
        return config.scalarSchemas[scalarName];
    }
    const tsType = visitor.getScalarType(scalarName);
    switch (tsType) {
        case 'string':
            return `z.string()`;
        case 'number':
            return `z.number()`;
        case 'boolean':
            return `z.boolean()`;
    }
    console.warn('unhandled scalar name:', scalarName);
    return anySchema;
};
