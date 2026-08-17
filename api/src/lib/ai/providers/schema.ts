// ─────────────────────────────────────────────────────────────────────────────
// Per-provider JSON Schema normalization.
//
// This is the part of multi-provider support that people underestimate. All three
// vendors accept "a JSON Schema", but each accepts a different dialect, and the
// disagreements are silent: a schema that works on Anthropic will be rejected by
// OpenAI strict mode and quietly mis-parsed by Gemini.
//
// The differences that actually bite, all present in this app's schemas:
//
//   Anthropic   Accepts ordinary JSON Schema draft-07 as a tool input_schema.
//               Nullable via {"type": ["number", "null"]}. Nothing to change.
//
//   OpenAI      Strict structured outputs require, at EVERY object level:
//                 - "additionalProperties": false
//                 - every key present in "required" (optionality is expressed by
//                   making the type nullable, not by omitting from required)
//               Omit either and the API rejects the request outright.
//
//   Gemini      Takes an OpenAPI 3.0 subset, not JSON Schema. Type unions are not
//               supported; nullability is {"type": "NUMBER", "nullable": true}.
//               Type names are upper-case. Unknown keywords are rejected.
//
// Every conversion here is lossless in the direction that matters: the resulting
// object still describes the same accepted values, so downstream validation and
// the hallucination guards in the feature modules behave identically.
// ─────────────────────────────────────────────────────────────────────────────

type Schema = Record<string, unknown>;

const isObj = (v: unknown): v is Schema => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Anthropic takes our schemas as authored. */
export function toAnthropicSchema(schema: Schema): Schema {
  return stripAnnotations(schema);
}

/**
 * OpenAI strict mode. Recursively forces additionalProperties:false and promotes
 * every declared property into `required`.
 *
 * Promoting to required is safe here because our optional fields are already
 * declared nullable (e.g. estRecoveryUsd is ["number","null"]). A field that was
 * optional and non-nullable would become mandatory — so this also normalizes those
 * to nullable rather than silently tightening the contract.
 */
export function toOpenAiSchema(schema: Schema): Schema {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isObj(node)) return node;

    const out: Schema = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'description' || k === 'type' || k === 'enum' || k === 'required') { out[k] = v; continue; }
      // `properties` is a map of NAME -> schema, not a schema itself. Recursing
      // into it as though it were one would treat property names as keywords.
      out[k] = k === 'properties' ? walkProperties(v, walk) : walk(v);
    }

    if (out.type === 'object' || isObj(out.properties)) {
      out.additionalProperties = false;
      const props = isObj(out.properties) ? Object.keys(out.properties) : [];
      const declared = new Set(Array.isArray(out.required) ? (out.required as string[]) : []);
      // Any property that was optional must become nullable before we force it
      // into `required`, or we would be tightening what the model may return.
      for (const p of props) {
        if (declared.has(p)) continue;
        const child = (out.properties as Schema)[p];
        if (isObj(child)) (out.properties as Schema)[p] = makeNullable(child);
      }
      out.required = props;
    }
    return out;
  };
  return walk(stripAnnotations(schema)) as Schema;
}

/**
 * Gemini / OpenAPI 3.0 subset. Upper-cases type names, converts ["X","null"]
 * unions to nullable, and drops keywords the API rejects.
 */
export function toGeminiSchema(schema: Schema): Schema {
  const TYPE_MAP: Record<string, string> = {
    string: 'STRING', number: 'NUMBER', integer: 'INTEGER',
    boolean: 'BOOLEAN', array: 'ARRAY', object: 'OBJECT',
  };
  const ALLOWED = new Set([
    'type', 'format', 'description', 'nullable', 'enum',
    'items', 'properties', 'required', 'propertyOrdering',
  ]);

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isObj(node)) return node;

    const out: Schema = {};
    let nullable = false;
    let type = node.type;

    if (Array.isArray(type)) {
      const types = (type as string[]).filter((t) => {
        if (t === 'null') { nullable = true; return false; }
        return true;
      });
      // Gemini cannot express a genuine union. Take the first concrete type — in
      // this app's schemas every union is exactly ["X","null"], so nothing is lost.
      type = types[0] ?? 'string';
    }

    for (const [k, v] of Object.entries(node)) {
      if (!ALLOWED.has(k)) continue;          // drop additionalProperties, $schema, etc.
      if (k === 'type') continue;             // handled below
      if (k === 'required') { out[k] = v; continue; }   // array of names, not schemas
      if (k === 'enum') {
        // A null inside an enum is expressed by `nullable`, not as a member.
        const vals = (v as unknown[]).filter((x) => x != null);
        if (vals.length !== (v as unknown[]).length) nullable = true;
        out[k] = vals.map(String);
        continue;
      }
      // `properties` maps NAME -> schema. Walking it as a schema would filter the
      // property names against ALLOWED and silently delete the entire object body.
      out[k] = k === 'properties' ? walkProperties(v, walk) : walk(v);
    }

    if (typeof type === 'string') out.type = TYPE_MAP[type] ?? type.toUpperCase();
    if (nullable) out.nullable = true;
    return out;
  };
  return walk(stripAnnotations(schema)) as Schema;
}

/**
 * Apply `walk` to each VALUE of a `properties` map, leaving the keys alone.
 * Property names are user data, not schema keywords, and must never be filtered
 * or rewritten.
 */
function walkProperties(props: unknown, walk: (n: unknown) => unknown): unknown {
  if (!isObj(props)) return props;
  const out: Schema = {};
  for (const [name, sub] of Object.entries(props)) out[name] = walk(sub);
  return out;
}

/** Make a schema node accept null, in ordinary JSON Schema terms. */
function makeNullable(node: Schema): Schema {
  const t = node.type;
  if (t == null) return node;
  if (Array.isArray(t)) return (t as string[]).includes('null') ? node : { ...node, type: [...(t as string[]), 'null'] };
  if (t === 'null') return node;
  return { ...node, type: [t as string, 'null'] };
}

/** Remove our own documentation keys, which no provider understands. */
function stripAnnotations(schema: Schema): Schema {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isObj(node)) return node;
    const out: Schema = {};
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('$comment') || k === '$schema') continue;
      out[k] = k === 'properties' ? walkProperties(v, walk) : walk(v);
    }
    return out;
  };
  return walk(schema) as Schema;
}
