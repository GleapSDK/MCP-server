// Arguments for a tool, made from the JSON Schema its tools/list entry declares: the smallest valid call, and a call the
// schema must refuse. Only the JSON Schema keywords the tools use today are handled; a new one fails loudly.
export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: JsonSchema | boolean;
  propertyNames?: JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  pattern?: string;
  format?: string;
  minLength?: number;
  minItems?: number;
  minimum?: number;
  exclusiveMinimum?: number;
};

// A value per pattern a tool declares, after a fresh id. A tool with a new pattern needs a line here.
const PATTERN_SAMPLES = [
  'en',
  'https://app.gleap.io/sample',
  'sample_key',
  '#1a2b3c',
  '2026-01-31',
  'Europe/Vienna',
  'sample.contact@example.com',
  '09:30',
];

const typesOf = (schema: JsonSchema): string[] => {
  const own = schema.type === undefined ? [] : [schema.type].flat();
  return [...own, ...[...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].flatMap(typesOf)];
};

/**
 * The smallest call `schema` accepts: required properties only, one entry per record, the first enum value and the
 * first branch. Every id-like string is a different 24-hex id, so ids that must be unique are.
 */
export const sampleArgs = (schema: JsonSchema, toolName: string): Record<string, unknown> => {
  let ids = 0;
  const nextId = () => `64f0c0ffee00000000${String(++ids).padStart(6, '0')}`;

  const sampleString = (string: JsonSchema, name: string): string => {
    if (string.format === 'email') return 'sample.contact@example.com';
    if (string.format === 'uri') return 'https://app.gleap.io/sample';
    const id = nextId();
    if (!string.pattern) return id.padEnd(string.minLength ?? 0, 'x');
    const pattern = new RegExp(string.pattern);
    const sample = [id, ...PATTERN_SAMPLES].find((candidate) => pattern.test(candidate));
    if (sample === undefined) throw new Error(`${name}: no sample matches /${string.pattern}/; add one to PATTERN_SAMPLES`);
    return sample;
  };

  const sampleObject = (object: JsonSchema, name: string): Record<string, unknown> => {
    const required = Object.fromEntries(
      (object.required ?? []).map((key) => [key, sample(object.properties?.[key] ?? {}, `${name}.${key}`)])
    );
    if (object.properties || typeof object.additionalProperties !== 'object') return required;
    const key = object.propertyNames ? sample(object.propertyNames, `${name} key`) : 'sample';
    return { [String(key)]: sample(object.additionalProperties, `${name}.${String(key)}`) };
  };

  const sample = (part: JsonSchema, name: string): unknown => {
    if (part.const !== undefined) return part.const;
    if (part.enum) return part.enum[0];
    const branch = part.anyOf?.[0] ?? part.oneOf?.[0];
    if (branch) return sample(branch, name);
    const type = [part.type].flat()[0];
    switch (type) {
      case 'object':
        return sampleObject(part, name);
      case 'array':
        return Array.from({ length: part.minItems ?? 0 }, () => sample(part.items ?? {}, `${name}[]`));
      case 'string':
        return sampleString(part, name);
      case 'integer':
      case 'number':
        return Math.max(1, part.minimum ?? 0, (part.exclusiveMinimum ?? 0) + 1);
      case 'boolean':
        return false;
      case 'null':
        return null;
      case undefined:
        return 'sample';
      default:
        throw new Error(`${name}: JSON Schema type ${type} has no sample yet`);
    }
  };

  return sampleObject(schema, toolName);
};

// A value, and the JSON Schema types that accept it.
const WRONG_VALUES: Array<[string[], unknown]> = [
  [['object'], { unexpected: true }],
  [['number', 'integer'], 12345],
  [['string'], 'not valid'],
  [['boolean'], true],
  [['array'], []],
];

/** Every property of `schema` set to a value of a type it does not accept, or null when no property declares a type. */
export const wronglyTypedArgs = (schema: JsonSchema): Record<string, unknown> | null => {
  const entries = Object.entries(schema.properties ?? {}).flatMap(([key, property]) => {
    const accepted = typesOf(property);
    const wrong = accepted.length ? WRONG_VALUES.find(([types]) => !types.some((type) => accepted.includes(type))) : undefined;
    return wrong ? [[key, wrong[1]] as const] : [];
  });
  return entries.length ? Object.fromEntries(entries) : null;
};
