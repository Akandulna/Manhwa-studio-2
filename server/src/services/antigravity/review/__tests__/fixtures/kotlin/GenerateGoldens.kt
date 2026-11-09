// Golden generator for ../../review.test.ts. Not part of the build.
//
// Compiled together with UNMODIFIED copies of the phone's clipper/CropSceneRules.kt, Handoff.kt, Json.kt,
// CropAudit.kt, CropReview.kt and AnalysisImport.kt (Sleeper-cell-main, branch v2), plus a Stubs.kt holding
// `object PageSections { SECTION_HEIGHT = 2048; WEBP_MAX_DIMENSION = 16383 }`, BrowserDatabase's
// CROP_RULES_PROMPT as `Rules.CROP_RULES_PROMPT`, and GeometryWorkflow.prompt(h) copied verbatim:
//
//   java -cp <kotlin-compiler-embeddable 2.2.0 + deps> org.jetbrains.kotlin.cli.jvm.K2JVMCompiler \
//     -no-stdlib -no-reflect -cp kotlin-stdlib-2.2.0.jar:json-20240303.jar -d classes src/*.kt
//   java -cp classes:kotlin-stdlib-2.2.0.jar:json-20240303.jar com.sleepercell.browser.clipper.MainKt
//
// It writes the files in this folder to /tmp/kgold/out. Note: the JVM org.json jar differs from Android's
// only in leniency for malformed JSON, which these inputs avoid.

package com.sleepercell.browser.clipper

import java.io.File

val SHA = "0123456789abcdef".repeat(4)

fun handoff3() = Handoff(
    jobId = "solo_leveling-ch010-page_003-0123456789ab",
    createdAt = "2026-11-07T10:00:00.000Z",
    source = HandoffSource("Solo Leveling", "solo_leveling", "Chapter 10", "10", "page_003", "page_003.jpg", SHA, 800, 5000, "jpeg"),
    slices = listOf(
        HandoffSlice("slice-01", "slice-01.webp", 0, 0, 800, 2048, 800, 2048, "a".repeat(64)),
        HandoffSlice("slice-02", "slice-02.webp", 0, 2048, 800, 4096, 800, 2048, "b".repeat(64)),
        HandoffSlice("slice-03", "slice-03.webp", 0, 4096, 800, 5000, 800, 904, "c".repeat(64)),
    ),
    manifestSha256 = "d".repeat(64),
)

fun handoffWhole() = Handoff(
    jobId = "tower-ch002-page_009-fedcba987654",
    createdAt = "2026-11-07T10:00:00.000Z",
    source = HandoffSource("Tower", "tower", "Chapter 2", "2", "page_009", "page_009.png", "f".repeat(64), 700, 1200, "png"),
    slices = listOf(HandoffSlice("slice-01", "page_009.png", 0, 0, 700, 1200, 700, 1200, "e".repeat(64))),
    manifestSha256 = "d".repeat(64),
    wholePage = true,
)

fun luma(): LumaPage {
    val w = 800; val h = 5000
    val data = ByteArray(w * h)
    for (y in 0 until h) for (x in 0 until w) {
        val checker = ((x / 3 + y / 3) % 2 == 0)
        val v = when {
            y in 100 until 1600 && x in 40 until 760 -> if (checker) 20 else 200
            y in 1700 until 2100 -> if (checker) 20 else 200
            y in 2248 until 4196 -> if (checker) 30 else 220
            y in 4596 until 4896 && x in 300 until 700 -> if (checker) 10 else 180
            else -> 255
        }
        data[y * w + x] = v.toByte()
    }
    return LumaPage(data, w, h)
}

fun c(id: String, s0: String, x0: Int, y0: Int, s1: String, x1: Int, y1: Int, reason: String = "framed_shot", flags: String = "[]") =
    """{"candidate_id":"$id","reason":"$reason","top_left":{"slice_id":"$s0","x":$x0,"y":$y0},"bottom_right":{"slice_id":"$s1","x":$x1,"y":$y1},"visual_evidence":"Visible border","review_flags":$flags}"""

fun analysisReply(cands: List<String>, jobId: String = "solo_leveling-ch010-page_003-0123456789ab", complete: Boolean = true) =
    """{"schema_version":"chatgpt-analysis/1.0","job_id":"$jobId","source_sha256":"$SHA","page_stem":"page_003","source_width":800,"source_height":5000,"coordinate_system":"slice_local_pixels","page_inspection_complete":$complete,"page_review_flags":[],"candidates":[${cands.joinToString(",")}]}"""

val CANDS = listOf(
    c("candidate-01", "slice-01", 40, 100, "slice-01", 760, 900, flags = """["boundary_uncertain","weird_flag"]"""),
    c("candidate-02", "slice-01", 40, 900, "slice-01", 760, 1500),
    c("candidate-03", "slice-02", 0, 200, "slice-03", 800, 100, reason = "tall_action"),
    c("candidate-04", "slice-03", 100, 300, "slice-03", 140, 340),
    c("candidate-05", "slice-03", 100, 300, "slice-03", 141, 340),
    c("candidate-06", "slice-03", 300, 500, "slice-03", 700, 800),
    c("candidate-07", "slice-03", 450, 550, "slice-03", 700, 800, reason = "speech_bubble"),
)

fun issues(list: List<ImportIssue>) = list.joinToString("\n") { "${it.code}|${it.field}|${it.message}|${it.candidateId}" }

fun main() {
    val out = File("/tmp/kgold/out").apply { mkdirs() }
    val h = handoff3()
    out.resolve("analysis-prompt.txt").writeText(HandoffFormat.withRules(GeometryWorkflow.prompt(h), Rules.CROP_RULES_PROMPT, null))
    out.resolve("analysis-prompt-whole.txt").writeText(HandoffFormat.withRules(GeometryWorkflow.prompt(handoffWhole()), Rules.CROP_RULES_PROMPT, null))
    out.resolve("crop-rules.txt").writeText(Rules.CROP_RULES_PROMPT)

    val parsed = AnalysisImport.parse(analysisReply(CANDS), h, geometryOnly = true)
    out.resolve("analysis-warnings.txt").writeText(issues(parsed.warnings) + "\n--\n" + issues(parsed.errors))
    val seeded = CropReview.seed(parsed.analysis!!, "2026-11-07T10:01:00.000Z")
    out.resolve("seeded.json").writeText(CropReview.toJson(seeded))
    val lp = luma()
    val audit = CropAudit.audit(seeded.sourceWidth, seeded.sourceHeight, seeded.crops.map { it.key to it.bounds }, lp, seeded.crops.associate { it.key to it.reason })
    out.resolve("audit.txt").writeText(audit.findings.joinToString("\n") { "${it.token}|${it.key}|${it.message}" } + "\n--\n" +
        audit.gaps.joinToString("\n") { "${it.y0}|${it.y1}|${it.inkShare}" })
    val items = CropReview.items(seeded, audit.findings)
    out.resolve("blockers-1.txt").writeText(CropReview.blockers(seeded, items, geometryOnly = true).joinToString("\n") { "${it.code}|${it.message}|${it.key}" })
    out.resolve("review-prompt.txt").writeText(CropReview.geometryReviewPrompt(seeded, items, audit, h, fresh = false, annotatedImages = false))
    val auditNoLuma = CropAudit.audit(seeded.sourceWidth, seeded.sourceHeight, seeded.crops.map { it.key to it.bounds }, null, seeded.crops.associate { it.key to it.reason })
    out.resolve("review-prompt-noluma.txt").writeText(CropReview.geometryReviewPrompt(seeded, CropReview.items(seeded, auditNoLuma.findings), auditNoLuma, h, fresh = false, annotatedImages = false))

    val tok1 = items.filter { it.key == "candidate-01" }.joinToString(",") { "\"${it.token}\"" }
    val reply = """```json
{"schema_version":"clipper-review-geometry/1.0","job_id":"${h.jobId}","source_sha256":"${SHA.uppercase()}","review_revision":1,"coordinate_system":"slice_local_pixels",
"crops":[
 {"key":"candidate-01","from_keys":["candidate-02"],"reason":"Framed Shot!","top_left":{"slice_id":"slice-01","x":40,"y":100},"bottom_right":{"slice_id":"slice-01","x":760,"y":1600},"checks_reviewed":[$tok1]},
 {"key":null,"from_keys":["candidate-03"],"reason":"","top_left":{"slice_id":"slice-02","x":0,"y":200},"bottom_right":{"slice_id":"slice-02","x":800,"y":1200},"checks_reviewed":[]},
 {"key":null,"from_keys":["candidate-03"],"top_left":{"slice_id":"slice-02","x":0,"y":1200},"bottom_right":{"slice_id":"slice-03","x":800,"y":100},"checks_reviewed":[]},
 {"key":"candidate-04","top_left":{"slice_id":"slice-03","x":100,"y":300},"bottom_right":{"slice_id":"slice-03","x":140,"y":340},"checks_reviewed":["TINY","MOSTLY_BLANK","bogus","TINY"]},
 {"key":"candidate-06","from_keys":["<key of the crop this was split from, or the keys merged into it; omit for a brand-new crop>"],"top_left":{"slice_id":"slice-03","x":300,"y":500},"bottom_right":{"slice_id":"slice-03","x":720,"y":800},"checks_reviewed":["HIGH_OVERLAP:candidate-06"]},
 {"key":null,"reason":"new_or_split_part","top_left":{"slice_id":"slice-01","x":0,"y":1700},"bottom_right":{"slice_id":"slice-02","x":800,"y":52},"checks_reviewed":[]}
],
"removed_keys":["candidate-05","candidate-07"],"redescribe_keys":["candidate-04","nope"],"sweep_done":true,"page_has_no_artwork":false,"notes":"  Merged hair cut.  "}
```"""
    out.resolve("review-reply.txt").writeText(reply)
    val applied = CropReview.applyReply(reply, seeded, items, h, "2026-11-07T10:02:00.000Z", geometryOnly = true)
    out.resolve("applied-issues.txt").writeText(issues(applied.warnings) + "\n--\n" + issues(applied.errors) + "\n--\n" + applied.changed)
    val next = applied.state!!
    out.resolve("applied.json").writeText(CropReview.toJson(next))
    val audit2 = CropAudit.audit(next.sourceWidth, next.sourceHeight, next.crops.map { it.key to it.bounds }, lp, next.crops.associate { it.key to it.reason })
    val items2 = CropReview.items(next, audit2.findings)
    out.resolve("blockers-2.txt").writeText(CropReview.blockers(next, items2, geometryOnly = true).joinToString("\n") { "${it.code}|${it.message}|${it.key}" })
    out.resolve("review-prompt-2.txt").writeText(CropReview.geometryReviewPrompt(next, items2, audit2, h, fresh = false, annotatedImages = false))

    // Rejections.
    val bad = linkedMapOf(
        "drop-key" to reply.replace("\"removed_keys\":[\"candidate-05\",\"candidate-07\"]", "\"removed_keys\":[\"candidate-05\"]"),
        "wrong-revision" to reply.replace("\"review_revision\":1", "\"review_revision\":2"),
        "bad-coords" to reply.replace("\"x\":720,\"y\":800", "\"x\":801,\"y\":800").replace("\"slice_id\":\"slice-01\",\"x\":0,\"y\":1700", "\"slice_id\":\"slice-09\",\"x\":0,\"y\":1700"),
        "twice" to reply.replace("\"removed_keys\":[\"candidate-05\",\"candidate-07\"]", "\"removed_keys\":[\"candidate-05\",\"candidate-07\",\"candidate-04\"]"),
        "wrong-schema" to reply.replace("clipper-review-geometry/1.0", "chatgpt-review/1.0").replace(h.jobId, "other"),
        "fraction" to reply.replace("\"x\":140,\"y\":340", "\"x\":140.5,\"y\":\"340\""),
        "inverted" to reply.replace("\"x\":140,\"y\":340", "\"x\":90,\"y\":340"),
    )
    out.resolve("review-rejections.txt").writeText(bad.entries.joinToString("\n==\n") { (name, text) ->
        val r = CropReview.applyReply(text, seeded, items, h, "now", geometryOnly = true)
        "$name\n" + issues(r.errors) + "\n--correction--\n" + CropReview.correctionPrompt(r.errors)
    })

    val badAnalysis = linkedMapOf(
        "wrong-job" to analysisReply(CANDS.take(1), jobId = "nope"),
        "oob" to analysisReply(listOf(c("candidate-01", "slice-01", 40, 100, "slice-01", 900, 3000))),
        "unknown-slice" to analysisReply(listOf(c("candidate-01", "slice-07", 40, 100, "slice-01", 700, 300))),
        "dup" to analysisReply(listOf(CANDS[0], CANDS[0])),
        "empty-complete" to analysisReply(emptyList()),
        "empty-incomplete" to analysisReply(emptyList(), complete = false),
        "fence" to "```json\n" + analysisReply(CANDS.take(1)) + "\n```",
        "messy" to analysisReply(listOf(
            """{"candidate_id":"  x1 ","reason":"Framed Reaction!","top_left":{"slice_id":"slice-01","x":40.0,"y":100},"bottom_right":{"slice_id":"slice-02","x":760,"y":10},"description":"A man.","review_flags":["tall_continuous_scene","tall_continuous_scene","odd"],"extra":1}""",
            """{"candidate_id":"","reason":"   ","top_left":{"slice_id":"slice-01","x":1.5,"y":"3"},"bottom_right":5,"visual_evidence":7}""",
            """{"candidate_id":"x2","reason":"!!!","top_left":{"slice_id":"slice-01","x":100,"y":100},"bottom_right":{"slice_id":"slice-01","x":50,"y":100}}""",
        )).replace("\"page_review_flags\":[]", "\"page_review_flags\":[\"needs_closer_view\"],\"bonus\":true"),
        "canonical" to """{"schema_version":"chatgpt-analysis/1.0","job_id":"${h.jobId}","source_sha256":"$SHA","page_stem":"page_003","source_width":800.0,"source_height":5000,"coordinate_system":"canonical_original_pixels","page_inspection_complete":true,"candidates":[{"candidate_id":"a","reason":"x","bounds":{"x0":0,"y0":0,"x1":800,"y1":5001}},{"candidate_id":"b","reason":"y","bounds":{"x0":0,"y0":10,"x1":800,"y1":500}}]}""",
        "identity" to """{"schema_version":"chatgpt-analysis/2","job_id":5,"source_sha256":null,"page_stem":"page_003","source_width":true,"source_height":"5000","coordinate_system":"pixels","page_inspection_complete":"yes","page_review_flags":[1],"candidates":{}}""",
        "not-object" to "[1,2]",
    )
    out.resolve("analysis-rejections.txt").writeText(badAnalysis.entries.joinToString("\n==\n") { (name, text) ->
        val r = AnalysisImport.parse(text, h, geometryOnly = true)
        "$name\n" + issues(r.errors) + "\n--warnings--\n" + issues(r.warnings) + "\n--candidates--\n" +
            (r.analysis?.candidates?.joinToString("\n") { "${it.candidateId}|${it.reason}|${it.bounds}|${it.slices}|${it.reviewFlags}|${it.unknownFlags}|${it.visualEvidence}|${it.description}" } ?: "null")
    })

    // Empty page and whole page review prompts.
    val empty = CropReview.seed(AnalysisImport.parse(analysisReply(emptyList()), h, true).analysis!!, "t")
    val emptyAudit = CropAudit.audit(800, 5000, emptyList(), lp)
    out.resolve("review-prompt-empty.txt").writeText(CropReview.geometryReviewPrompt(empty, emptyList(), emptyAudit, h, fresh = false, annotatedImages = false))
    val hw = handoffWhole()
    val wholeReply = """{"schema_version":"chatgpt-analysis/1.0","job_id":"${hw.jobId}","source_sha256":"${"f".repeat(64)}","page_stem":"page_009","source_width":700,"source_height":1200,"coordinate_system":"slice_local_pixels","page_inspection_complete":true,"candidates":[{"candidate_id":"candidate-01","reason":"wide","top_left":{"slice_id":"slice-01","x":0,"y":0},"bottom_right":{"slice_id":"slice-01","x":700,"y":500}}]}"""
    val ws = CropReview.seed(AnalysisImport.parse(wholeReply, hw, true).analysis!!, "t")
    val wa = CropAudit.audit(700, 1200, ws.crops.map { it.key to it.bounds }, null)
    out.resolve("review-prompt-whole.txt").writeText(CropReview.geometryReviewPrompt(ws, CropReview.items(ws, wa.findings), wa, hw, fresh = false, annotatedImages = false))
    println("ok")
}
