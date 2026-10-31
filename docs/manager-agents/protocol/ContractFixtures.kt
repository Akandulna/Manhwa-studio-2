// Android JVM contract test; validated through android-fixtures.init.gradle.
// The init script supplies the fixture directory without changing app sources or building an APK.
package com.sleepercell.browser.managercontracts

import java.io.File
import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ContractFixtures {
    private fun elements(a: JSONArray) = (0 until a.length()).map { a.get(it) }
    private fun same(a: Any?, b: Any?) = a == b || (a == JSONObject.NULL && b == null)

    // Only the draft-07 keywords used by this contract; fail on unsupported schema keywords.
    private fun matches(s: JSONObject, value: Any?): Boolean {
        val supported = setOf("\$schema", "title", "oneOf", "anyOf", "const", "enum", "type",
            "properties", "required", "additionalProperties", "items", "minLength", "maxLength",
            "minimum", "maximum", "maxItems", "pattern", "format")
        require(s.keys().asSequence().all { it in supported }) { "Unsupported schema keyword" }
        if (s.has("oneOf")) return elements(s.getJSONArray("oneOf")).count { matches(it as JSONObject, value) } == 1
        if (s.has("anyOf")) return elements(s.getJSONArray("anyOf")).any { matches(it as JSONObject, value) }
        if (s.has("const") && !same(s.get("const"), value)) return false
        if (s.has("enum") && elements(s.getJSONArray("enum")).none { same(it, value) }) return false
        val kinds = when (val t = s.opt("type")) {
            is String -> listOf(t)
            is JSONArray -> elements(t).map { it as String }
            else -> emptyList()
        }
        fun isKind(k: String) = when (k) {
            "null" -> value == null || value == JSONObject.NULL
            "string" -> value is String
            "object" -> value is JSONObject
            "array" -> value is JSONArray
            "boolean" -> value is Boolean
            "integer" -> value is Number && value.toDouble().isFinite() && value.toDouble() % 1.0 == 0.0
            "number" -> value is Number && value.toDouble().isFinite()
            else -> error("Unsupported schema type $k")
        }
        if (kinds.isNotEmpty() && kinds.none(::isKind)) return false
        if (value is JSONObject && s.has("properties")) {
            val props = s.getJSONObject("properties")
            if (elements(s.getJSONArray("required")).any { !value.has(it as String) }) return false
            if (!s.optBoolean("additionalProperties", true) && value.keys().asSequence().any { !props.has(it) }) return false
            if (value.keys().asSequence().any { props.has(it) && !matches(props.getJSONObject(it), value.get(it)) }) return false
        }
        if (value is JSONArray) {
            if (s.has("maxItems") && value.length() > s.getInt("maxItems")) return false
            if (s.has("items") && elements(value).any { !matches(s.getJSONObject("items"), it) }) return false
        }
        if (value is Number) {
            if (s.has("minimum") && value.toDouble() < s.getDouble("minimum")) return false
            if (s.has("maximum") && value.toDouble() > s.getDouble("maximum")) return false
        }
        if (value is String) {
            val length = value.codePointCount(0, value.length)
            if (s.has("minLength") && length < s.getInt("minLength")) return false
            if (s.has("maxLength") && length > s.getInt("maxLength")) return false
            if (s.has("pattern") && !Regex(s.getString("pattern")).containsMatchIn(value)) return false
            if (s.optString("format") == "date-time" && runCatching { Instant.parse(value) }.isFailure) return false
        }
        return true
    }

    @Test fun sharedWireCorpus() {
        val dir = File(requireNotNull(System.getenv("MANAGER_CONTRACT_FIXTURES_DIR")))
        val schema = JSONObject(File(dir, "records.schema.json").readText())
        val fixtures = JSONObject(File(dir, "fixtures.json").readText())
        val valid = elements(fixtures.getJSONArray("valid")).map { it as JSONObject }
        valid.forEach { assertTrue(it.getString("kind"), matches(schema, it)) }
        elements(fixtures.getJSONArray("invalid")).forEach { raw ->
            val fixture = raw as JSONObject
            val record = JSONObject(valid.first { it.getString("kind") == fixture.getString("base") }.toString())
            val path = elements(fixture.getJSONArray("path"))
            var parent: Any = record
            path.dropLast(1).forEach { key -> parent = if (parent is JSONObject) (parent as JSONObject).get(key as String) else (parent as JSONArray).get((key as Number).toInt()) }
            val key = path.last() as String
            if (fixture.optBoolean("delete")) (parent as JSONObject).remove(key)
            else (parent as JSONObject).put(key, fixture.get("value"))
            assertFalse(fixture.getString("name"), matches(schema, record))
        }
    }
}
