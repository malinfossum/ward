// JSON as npm reads it. A UTF-8 BOM (some Windows editors write one) is not
// JSON, but npm skips it, so a package.json that npm ci accepts must parse
// here too, in apply, the node contract, the drift check and the hygiene sweep.
export const BOM = "\uFEFF";

export const parseJson = (text) => JSON.parse(text.startsWith(BOM) ? text.slice(1) : text);
