/**
 * JSON and Kotlin-string helpers that make the port behave like the phone.
 *
 * - Reading follows Android's org.json (AOSP libcore JSONTokener/JSONObject/JSONArray), which the phone
 *   uses at run time. It is lenient: comments (/* *\/, //, #), single-quoted and unquoted strings,
 *   `=`/`=>` separators, `;` between members, empty array slots (read as null), a leading BOM, octal
 *   (`010`) and hex (`0x10`) integers. Accepting exactly what the phone accepts is what keeps the
 *   validators' accept/reject decisions identical.
 * - Writing follows the phone's `Json.stringify` (JavaScript JSON.stringify layout: key order kept,
 *   two-space indent with `pretty`, only the escapes it uses), because that text appears inside prompts.
 * - The Kotlin string helpers reproduce `Char.isWhitespace`, `trim()`, `isBlank()` and `trimIndent()`.
 */
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------------------------------------
// Parsed values (Android org.json's object model)
// ---------------------------------------------------------------------------------------------------------

/** org.json's `JSONObject.NULL`: an explicit JSON null, as opposed to a missing key. */
export class JsonNull {
  toString(): string {
    return 'null'
  }
}
export const JNULL = new JsonNull()

/**
 * A number as Android's tokener types it: `int` (fits a Java Integer), `long` (a Java Long, kept exactly in
 * [big]) or `double`. [value] is the number as a double (Kotlin's `toDouble()`).
 */
export class JsonNumber {
  constructor(
    readonly kind: 'int' | 'long' | 'double',
    readonly value: number,
    readonly big: bigint | null = null,
  ) {}
}

/** A JSONObject: insertion-ordered; a repeated key keeps its first position and takes the last value. */
export class JsonObject {
  readonly map = new Map<string, JsonValue>()
  /** Kotlin's `JSONObject.value(key)`: undefined when absent (Kotlin null), [JNULL] for an explicit null. */
  value(key: string): JsonValue | undefined {
    return this.map.get(key)
  }
  has(key: string): boolean {
    return this.map.has(key)
  }
  keyList(): string[] {
    return [...this.map.keys()]
  }
}

/** A JSONArray. An empty slot (`[1,,2]`, `[1,]`) is a Java null, here `undefined`. */
export class JsonArray {
  readonly items: (JsonValue | undefined)[] = []
}

export type JsonValue = JsonObject | JsonArray | JsonNumber | string | boolean | JsonNull

export class JsonException extends Error {}

// ---------------------------------------------------------------------------------------------------------
// Android JSONTokener
// ---------------------------------------------------------------------------------------------------------

const INT_MIN = -(2n ** 31n)
const INT_MAX = 2n ** 31n - 1n
const LONG_MIN = -(2n ** 63n)
const LONG_MAX = 2n ** 63n - 1n

class Tokener {
  private pos = 0
  private readonly input: string

  constructor(input: string) {
    // AOSP consumes an optional byte order mark.
    this.input = input.startsWith('﻿') ? input.substring(1) : input
  }

  private syntaxError(message: string): JsonException {
    return new JsonException(`${message} at character ${this.pos} of ${this.input}`)
  }

  nextValue(): JsonValue {
    const c = this.nextCleanInternal()
    switch (c) {
      case -1:
        throw this.syntaxError('End of input')
      case 0x7b: // {
        return this.readObject()
      case 0x5b: // [
        return this.readArray()
      case 0x27: // '
      case 0x22: // "
        return this.nextString(c)
      default:
        this.pos--
        return this.readLiteral()
    }
  }

  nextCleanInternal(): number {
    while (this.pos < this.input.length) {
      const c = this.input.charCodeAt(this.pos++)
      switch (c) {
        case 0x09:
        case 0x20:
        case 0x0a:
        case 0x0d:
          continue
        case 0x2f: { // '/'
          if (this.pos === this.input.length) return c
          const peek = this.input.charCodeAt(this.pos)
          if (peek === 0x2a) { // /* comment */
            this.pos++
            const end = this.input.indexOf('*/', this.pos)
            if (end === -1) throw this.syntaxError('Unterminated comment')
            this.pos = end + 2
            continue
          }
          if (peek === 0x2f) { // // comment
            this.pos++
            this.skipToEndOfLine()
            continue
          }
          return c
        }
        case 0x23: // # comment
          this.skipToEndOfLine()
          continue
        default:
          return c
      }
    }
    return -1
  }

  private skipToEndOfLine(): void {
    for (; this.pos < this.input.length; this.pos++) {
      const c = this.input.charCodeAt(this.pos)
      if (c === 0x0d || c === 0x0a) {
        this.pos++
        break
      }
    }
  }

  private nextString(quote: number): string {
    let builder: string | null = null
    let start = this.pos
    while (this.pos < this.input.length) {
      const c = this.input.charCodeAt(this.pos++)
      if (c === quote) {
        if (builder === null) return this.input.substring(start, this.pos - 1)
        return builder + this.input.substring(start, this.pos - 1)
      }
      if (c === 0x5c) { // backslash
        if (this.pos === this.input.length) throw this.syntaxError('Unterminated escape sequence')
        builder = (builder ?? '') + this.input.substring(start, this.pos - 1) + this.readEscapeCharacter()
        start = this.pos
      }
    }
    throw this.syntaxError('Unterminated string')
  }

  private readEscapeCharacter(): string {
    const escaped = this.input.charAt(this.pos++)
    switch (escaped) {
      case 'u': {
        if (this.pos + 4 > this.input.length) throw this.syntaxError('Unterminated escape sequence')
        const hex = this.input.substring(this.pos, this.pos + 4)
        this.pos += 4
        // Integer.parseInt(hex, 16): an optional sign, then hex digits.
        if (!/^[+-]?[0-9a-fA-F]+$/.test(hex)) throw this.syntaxError(`Invalid escape sequence: ${hex}`)
        return String.fromCharCode(parseInt(hex, 16) & 0xffff)
      }
      case 't':
        return '\t'
      case 'b':
        return '\b'
      case 'n':
        return '\n'
      case 'r':
        return '\r'
      case 'f':
        return '\f'
      default: // \' \" \\ \/ and anything else stand for themselves
        return escaped
    }
  }

  private nextToInternal(excluded: string): string {
    const start = this.pos
    for (; this.pos < this.input.length; this.pos++) {
      const c = this.input.charAt(this.pos)
      if (c === '\r' || c === '\n' || excluded.includes(c)) return this.input.substring(start, this.pos)
    }
    return this.input.substring(start)
  }

  private readLiteral(): JsonValue {
    const literal = this.nextToInternal('{}[]/\\:,=;# \t\f')
    if (literal.length === 0) throw this.syntaxError('Expected literal value')
    if (javaEqualsIgnoreCase(literal, 'null')) return JNULL
    if (javaEqualsIgnoreCase(literal, 'true')) return true
    if (javaEqualsIgnoreCase(literal, 'false')) return false

    // Integral types first...
    if (!literal.includes('.')) {
      let base = 10
      let number = literal
      if (number.startsWith('0x') || number.startsWith('0X')) {
        number = number.substring(2)
        base = 16
      } else if (number.startsWith('0') && number.length > 1) {
        number = number.substring(1)
        base = 8
      }
      const long = parseJavaLong(number, base)
      if (long !== null) {
        return long >= INT_MIN && long <= INT_MAX
          ? new JsonNumber('int', Number(long))
          : new JsonNumber('long', Number(long), long)
      }
    }
    // ...then floating point...
    const double = parseJavaDouble(literal)
    if (double !== null) return new JsonNumber('double', double)
    // ...finally an unquoted string.
    return literal
  }

  private readArray(): JsonArray {
    const result = new JsonArray()
    let hasTrailingSeparator = false
    for (;;) {
      switch (this.nextCleanInternal()) {
        case -1:
          throw this.syntaxError('Unterminated array')
        case 0x5d: // ]
          if (hasTrailingSeparator) result.items.push(undefined)
          return result
        case 0x2c: // ,
        case 0x3b: // ;
          // A separator without a value first means "null".
          result.items.push(undefined)
          hasTrailingSeparator = true
          continue
        default:
          this.pos--
      }
      result.items.push(this.nextValue())
      switch (this.nextCleanInternal()) {
        case 0x5d:
          return result
        case 0x2c:
        case 0x3b:
          hasTrailingSeparator = true
          continue
        default:
          throw this.syntaxError('Unterminated array')
      }
    }
  }

  private readObject(): JsonObject {
    const result = new JsonObject()
    const first = this.nextCleanInternal()
    if (first === 0x7d) return result
    if (first !== -1) this.pos--
    for (;;) {
      const name = this.nextValue()
      if (typeof name !== 'string') {
        throw this.syntaxError(`Names must be strings, but ${javaToString(name)} is of type ${javaClassName(name)}`)
      }
      const separator = this.nextCleanInternal()
      if (separator !== 0x3a && separator !== 0x3d) throw this.syntaxError(`Expected ':' after ${name}`)
      if (this.pos < this.input.length && this.input.charAt(this.pos) === '>') this.pos++
      const value = this.nextValue()
      // JSONObject.put checks every Number for NaN and infinities.
      if (value instanceof JsonNumber && !Number.isFinite(value.value)) {
        throw new JsonException(`Forbidden numeric value: ${javaDoubleToString(value.value)}`)
      }
      result.map.set(name, value)
      switch (this.nextCleanInternal()) {
        case 0x7d:
          return result
        case 0x3b:
        case 0x2c:
          continue
        default:
          throw this.syntaxError('Unterminated object')
      }
    }
  }
}

/**
 * The phone's `Json.parse`: one JSON value that must be the whole of [text]. Throws [JsonException] for
 * anything else, like trailing prose.
 */
export function parseJson(text: string): JsonValue {
  const tokener = new Tokener(text)
  const value = tokener.nextValue()
  const next = tokener.nextCleanInternal()
  // nextClean() maps end of input to '\0', so a literal NUL also ends the text, as on the phone.
  if (next !== -1 && next !== 0) throw new JsonException('Unexpected text after the JSON value')
  return value
}

function javaEqualsIgnoreCase(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a.charAt(i)
    const y = b.charAt(i)
    if (x === y) continue
    const ux = x.toUpperCase()
    const uy = y.toUpperCase()
    if (ux.length === 1 && ux === uy) continue
    const lx = ux.toLowerCase()
    if (lx.length === 1 && lx === uy.toLowerCase()) continue
    return false
  }
  return true
}

/** Long.parseLong(s, radix): optional sign, at least one digit, within the Long range; else null. */
function parseJavaLong(s: string, radix: number): bigint | null {
  if (s.length === 0) return null
  let i = 0
  let negative = false
  if (s[0] === '-' || s[0] === '+') {
    negative = s[0] === '-'
    i = 1
    if (s.length === 1) return null
  }
  let result = 0n
  const big = BigInt(radix)
  for (; i < s.length; i++) {
    const digit = parseInt(s[i]!, 36)
    if (Number.isNaN(digit) || digit >= radix) return null
    result = result * big + BigInt(digit)
  }
  if (negative) result = -result
  if (result < LONG_MIN || result > LONG_MAX) return null
  return result
}

const JAVA_DECIMAL = /^[+-]?(?:NaN|Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[fFdD]?)$/
const JAVA_HEX = /^([+-]?)0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?[pP]([+-]?\d+)[fFdD]?$/

/** Double.valueOf(s): Java's floating-point literal grammar, with surrounding chars <= ' ' trimmed; else null. */
function parseJavaDouble(raw: string): number | null {
  let start = 0
  let end = raw.length
  while (start < end && raw.charCodeAt(start) <= 0x20) start++
  while (end > start && raw.charCodeAt(end - 1) <= 0x20) end--
  const s = raw.substring(start, end)
  if (JAVA_DECIMAL.test(s)) {
    const body = s.replace(/[fFdD]$/, '')
    if (body.endsWith('NaN')) return NaN
    if (body.endsWith('Infinity')) return body.startsWith('-') ? -Infinity : Infinity
    return Number(body)
  }
  const hex = JAVA_HEX.exec(s)
  if (hex) {
    const whole = hex[2] ?? ''
    const fraction = hex[3] ?? ''
    if (whole.length + fraction.length === 0) return null
    const mantissa = BigInt(`0x${whole}${fraction}`)
    const exponent = Number(hex[4]) - 4 * fraction.length
    const value = Number(mantissa) * Math.pow(2, exponent)
    return hex[1] === '-' ? -value : value
  }
  return null
}

function javaClassName(value: JsonValue): string {
  if (value instanceof JsonObject) return 'org.json.JSONObject'
  if (value instanceof JsonArray) return 'org.json.JSONArray'
  if (value instanceof JsonNull) return 'org.json.JSONObject$1'
  if (value instanceof JsonNumber) {
    return value.kind === 'int' ? 'java.lang.Integer' : value.kind === 'long' ? 'java.lang.Long' : 'java.lang.Double'
  }
  if (typeof value === 'boolean') return 'java.lang.Boolean'
  return 'java.lang.String'
}

/** Java's toString of a parsed value (containers are written compactly; Android's escaping may differ slightly). */
function javaToString(value: JsonValue): string {
  if (value instanceof JsonNumber) {
    if (value.kind === 'long' && value.big !== null) return value.big.toString()
    return value.kind === 'int' ? String(value.value) : javaDoubleToString(value.value)
  }
  if (value instanceof JsonObject || value instanceof JsonArray) return stringify(toPlain(value))
  return String(value)
}

/** Java's Double.toString: "1.0", "0.001", "1.0E7", "1.5E-4", "NaN", "Infinity". */
export function javaDoubleToString(d: number): string {
  if (Number.isNaN(d)) return 'NaN'
  if (!Number.isFinite(d)) return d > 0 ? 'Infinity' : '-Infinity'
  if (d === 0) return Object.is(d, -0) ? '-0.0' : '0.0'
  const abs = Math.abs(d)
  const sign = d < 0 ? '-' : ''
  const [mantissa, exp] = abs.toExponential().split('e') as [string, string]
  const exponent = Number(exp)
  const digits = mantissa.replace('.', '')
  if (abs >= 1e-3 && abs < 1e7) {
    const plain = plainDecimal(digits, exponent)
    return sign + (plain.includes('.') ? plain : `${plain}.0`)
  }
  const head = digits[0]!
  const tail = digits.length > 1 ? digits.substring(1) : '0'
  return `${sign}${head}.${tail}E${exponent}`
}

/** Shortest digits [digits] (d.ddd…) times 10^[exponent], written without an exponent. */
function plainDecimal(digits: string, exponent: number): string {
  const point = exponent + 1
  if (point <= 0) return `0.${'0'.repeat(-point)}${digits}`
  if (point >= digits.length) return digits + '0'.repeat(point - digits.length)
  return `${digits.substring(0, point)}.${digits.substring(point)}`
}

/** Converts a parsed value back to plain data (objects keep key order). Java nulls become null. */
export function toPlain(value: JsonValue | undefined): WritableJson {
  if (value === undefined || value instanceof JsonNull) return null
  if (value instanceof JsonNumber) return value.value
  if (value instanceof JsonArray) return value.items.map(toPlain)
  if (value instanceof JsonObject) {
    const out: { [key: string]: WritableJson } = {}
    for (const [key, item] of value.map) out[key] = toPlain(item)
    return out
  }
  return value
}

// ---------------------------------------------------------------------------------------------------------
// The phone's Json helpers
// ---------------------------------------------------------------------------------------------------------

/** What [stringify] can write: plain JSON data; object key order is kept. */
export type WritableJson = null | string | boolean | number | WritableJson[] | { [key: string]: WritableJson }

/** The phone's `Json.stringify(value, pretty)`: JSON.stringify's layout, two-space indent when [pretty]. */
export function stringify(value: WritableJson, pretty = false): string {
  const out: string[] = []
  write(out, value, pretty ? '' : null)
  return out.join('')
}

function write(out: string[], value: WritableJson, indent: string | null): void {
  if (value === null) {
    out.push('null')
  } else if (typeof value === 'string') {
    quote(out, value)
  } else if (typeof value === 'boolean') {
    out.push(String(value))
  } else if (typeof value === 'number') {
    out.push(numberText(value))
  } else if (Array.isArray(value)) {
    container(out, value, '[', ']', indent, (item, inner) => write(out, item, inner))
  } else {
    container(out, Object.entries(value), '{', '}', indent, ([key, item], inner) => {
      quote(out, key)
      out.push(inner !== null ? ': ' : ':')
      write(out, item, inner)
    })
  }
}

function container<T>(out: string[], items: T[], open: string, close: string, indent: string | null, writeItem: (item: T, inner: string | null) => void): void {
  out.push(open)
  if (items.length === 0) {
    out.push(close)
    return
  }
  const inner = indent !== null ? `${indent}  ` : null
  items.forEach((item, i) => {
    if (i > 0) out.push(',')
    if (inner !== null) out.push('\n', inner)
    writeItem(item, inner)
  })
  if (indent !== null) out.push('\n', indent)
  out.push(close)
}

function quote(out: string[], text: string): void {
  let s = '"'
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 0x22) s += '\\"'
    else if (c === 0x5c) s += '\\\\'
    else if (c === 0x08) s += '\\b'
    else if (c === 0x0c) s += '\\f'
    else if (c === 0x0a) s += '\\n'
    else if (c === 0x0d) s += '\\r'
    else if (c === 0x09) s += '\\t'
    else if (c < 0x20) s += `\\u${c.toString(16).padStart(4, '0')}`
    else s += text.charAt(i)
  }
  out.push(s + '"')
}

/**
 * The phone's `Json.number` (Kotlin writes Int/Long as is, which is the same text for whole numbers):
 * a finite number without a needless ".0" or exponent: 800.0 -> "800", 0.5 -> "0.5". */
export function numberText(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`JSON can't hold ${value}`)
  if (value === 0) return '0'
  const sign = value < 0 ? '-' : ''
  const [mantissa, exp] = Math.abs(value).toExponential().split('e') as [string, string]
  return sign + plainDecimal(mantissa.replace('.', ''), Number(exp))
}

/** [value] as a whole number, the way JavaScript's Number.isInteger sees it, or null (phone's `Json.wholeNumber`). */
export function wholeNumber(value: JsonValue | undefined): bigint | null {
  if (!(value instanceof JsonNumber)) return null
  if (value.kind === 'long' && value.big !== null) return value.big
  if (value.kind === 'int') return BigInt(value.value)
  const d = value.value
  return Number.isFinite(d) && d === Math.floor(d) && Math.abs(d) < 9.007199254740992e15 ? BigInt(d) : null
}

export function isNumber(value: JsonValue | undefined): boolean {
  return value instanceof JsonNumber && Number.isFinite(value.value)
}

/**
 * How the importer names a value in its messages: "missing", "null", a quoted string cut at 40
 * characters, "an array", "an object", or the value itself (phone's `Json.describe`).
 */
export function describe(value: JsonValue | number | undefined): string {
  if (value === undefined) return 'missing'
  if (value instanceof JsonNull) return 'null'
  if (typeof value === 'string') return stringify(value.length > 40 ? `${value.substring(0, 40)}…` : value)
  if (value instanceof JsonArray) return 'an array'
  if (value instanceof JsonObject) return 'an object'
  if (typeof value === 'number') return Number.isFinite(value) ? numberText(value) : javaDoubleToString(value)
  if (value instanceof JsonNumber) return Number.isFinite(value.value) ? numberText(value.value) : javaDoubleToString(value.value)
  return String(value)
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------------------------------------
// Kotlin strings
// ---------------------------------------------------------------------------------------------------------

const KOTLIN_WHITESPACE = /[\t\n\u000B\f\r\u001C-\u001F\p{Zs}\u2028\u2029]/u

/** Kotlin's `Char.isWhitespace()` (Character.isWhitespace or isSpaceChar). */
export function isWhitespace(ch: string): boolean {
  return KOTLIN_WHITESPACE.test(ch)
}

/** Kotlin's `String.trim()`. */
export function ktTrim(text: string): string {
  let start = 0
  let end = text.length
  while (start < end && isWhitespace(text.charAt(start))) start++
  while (end > start && isWhitespace(text.charAt(end - 1))) end--
  return text.substring(start, end)
}

/** Kotlin's `String.isBlank()`. */
export function isBlank(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (!isWhitespace(text.charAt(i))) return false
  return true
}

/** Kotlin's `String.trim(char)`. */
export function trimChar(text: string, ch: string): string {
  let start = 0
  let end = text.length
  while (start < end && text.charAt(start) === ch) start++
  while (end > start && text.charAt(end - 1) === ch) end--
  return text.substring(start, end)
}

/**
 * Kotlin's `String.trimIndent()`: drops the first and last lines when blank and removes the smallest
 * indent of the non-blank lines from every line.
 */
export function trimIndent(text: string): string {
  const lines = text.split(/\r\n|\n|\r/)
  const indents = lines.filter((line) => !isBlank(line)).map((line) => {
    for (let i = 0; i < line.length; i++) if (!isWhitespace(line.charAt(i))) return i
    return line.length
  })
  const min = indents.length > 0 ? Math.min(...indents) : 0
  const last = lines.length - 1
  return lines
    .flatMap((line, index) => ((index === 0 || index === last) && isBlank(line) ? [] : [line.substring(min)]))
    .join('\n')
}
