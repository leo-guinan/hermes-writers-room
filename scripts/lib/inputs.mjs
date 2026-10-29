// Parsing and schema validation for input files. Shared by the PR validator and the taping run.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import YAML from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
export const SCHEMA = JSON.parse(readFileSync(join(here, "..", "..", "schemas", "input.schema.json"), "utf8"));

export const LIMITS = { frontMatterBytes: 4000, bodyChars: 20000, filesPerPr: 10 };
export const INPUT_PATH = /^inputs\/(\d{4}-\d{2}-\d{2})\/([a-z0-9][a-z0-9-]{2,60})\.md$/;

// strictRequired off: the if/then blocks require properties declared on the parent schema.
const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false });
const validateSchema = ajv.compile(SCHEMA);

export function validDate(s) {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Split "---\n<yaml>\n---\n<body>" into parts. Throws a readable Error on malformed files. */
export function splitFrontMatter(text) {
  const t = text.replace(/\r\n/g, "\n");
  if (!t.startsWith("---\n")) throw new Error("file must start with a '---' front matter block");
  const end = t.indexOf("\n---\n", 4);
  const endAtEof = t.endsWith("\n---") && end === -1;
  if (end === -1 && !endAtEof) throw new Error("front matter block is not closed with '---'");
  const fm = end === -1 ? t.slice(4, -4) : t.slice(4, end);
  const body = end === -1 ? "" : t.slice(end + 5);
  return { fm, body };
}

/** Parse and validate one input file's text. Returns { ok, errors, data, body }. */
export function parseInput(text) {
  const errors = [];
  let parts;
  try {
    parts = splitFrontMatter(text);
  } catch (e) {
    return { ok: false, errors: [e.message] };
  }
  if (Buffer.byteLength(parts.fm) > LIMITS.frontMatterBytes) errors.push(`front matter is over ${LIMITS.frontMatterBytes} bytes`);
  if (parts.body.length > LIMITS.bodyChars) errors.push(`body is over ${LIMITS.bodyChars} characters`);
  if (errors.length) return { ok: false, errors };
  let data;
  try {
    data = YAML.parse(parts.fm, { schema: "core", maxAliasCount: 0 });
  } catch (e) {
    return { ok: false, errors: [`front matter is not valid YAML: ${e.message.split("\n")[0]}`] };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return { ok: false, errors: ["front matter must be a mapping"] };
  if (!validateSchema(data)) {
    for (const e of validateSchema.errors ?? []) errors.push(`${e.instancePath || "(root)"} ${e.message}${e.params?.allowedValues ? ` (${e.params.allowedValues.join(", ")})` : ""}`);
    return { ok: false, errors, data };
  }
  if (!parts.body.trim()) errors.push("body is empty: say what the input is");
  return { ok: errors.length === 0, errors, data, body: parts.body };
}
