import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { KeyComputer, type ProblemBuffers } from "../../lib/index.ts"
import { results as z04Results } from "high-density-dataset-z04/results"

interface DatasetResultRow {
  fileName: string
  didSolve: boolean
  timeSeconds?: number
}

interface DatasetResult {
  id: string
  data: readonly DatasetResultRow[]
}

interface RawPortPoint {
  x: number
  y: number
  z: number
  rootConnectionName: string
}

interface RawProblem {
  center: { x: number; y: number }
  width: number
  height: number
  portPoints: RawPortPoint[]
}

interface ProjectedSample {
  fileName: string
  didSolve: boolean
  problem: ProblemBuffers
}

interface ParameterRow {
  binsPerSide: number
  ratioBucketsPerOctave: number
  sampleCount: number
  uniqueKeys: number
  collidingKeys: number
  collisionSamples: number
  mixedDidSolveKeys: number
  errorCollisions: number
}

interface LoadSamplesResult {
  samples: ProjectedSample[]
  skippedSharedNetSamples: number
  skippedOutOfRangeAspectSamples: number
  missingProblemFiles: string[]
}

interface CliOptions {
  binsPerSide: number[]
  ratioBucketsPerOctaveList: number[]
  resultId?: string
}

const DEFAULT_BINS_PER_SIDE = [2, 4, 8, 16, 32, 64]
const DEFAULT_RATIO_BUCKETS_PER_OCTAVE = [2, 4, 8, 16]
const MAX_SUPPORTED_ASPECT_RATIO = 4
const DATASET_ROOT = fileURLToPath(
  new URL("../../node_modules/high-density-dataset-z04/", import.meta.url),
)
const PROBLEMS_DIR = join(DATASET_ROOT, "hg-problem")

function parseCliOptions(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    binsPerSide: [...DEFAULT_BINS_PER_SIDE],
    ratioBucketsPerOctaveList: [...DEFAULT_RATIO_BUCKETS_PER_OCTAVE],
  }

  for (const arg of argv) {
    if (arg === "--help") {
      printHelp()
      process.exit(0)
    }

    if (arg.startsWith("--bins=")) {
      options.binsPerSide = parseNonNegativeIntegerList(
        arg.slice("--bins=".length),
        "bins",
      )
      continue
    }

    if (arg.startsWith("--ratio=")) {
      options.ratioBucketsPerOctaveList = [
        parseNonNegativeInteger(arg.slice("--ratio=".length), "ratio"),
      ]
      continue
    }

    if (arg.startsWith("--ratios=")) {
      options.ratioBucketsPerOctaveList = parseNonNegativeIntegerList(
        arg.slice("--ratios=".length),
        "ratios",
      )
      continue
    }

    if (arg.startsWith("--result-id=")) {
      options.resultId = arg.slice("--result-id=".length)
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  return options
}

function parseNonNegativeIntegerList(value: string, label: string): number[] {
  const out = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => parseNonNegativeInteger(part, label))

  if (out.length === 0) {
    throw new Error(`Expected at least one integer for --${label}.`)
  }

  return [...new Set(out)].sort((a, b) => a - b)
}

function parseNonNegativeInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `Expected --${label} to be a non-negative integer, received "${value}".`,
    )
  }
  return Number(value)
}

function printHelp(): void {
  console.log(
    [
      "Usage: bun run scripts/collision-testing/print-collisions-for-different-parameters.ts [options]",
      "",
      "Options:",
      `  --bins=2,4,8,16,32,64   Comma-separated binsPerSide values (default: ${DEFAULT_BINS_PER_SIDE.join(",")})`,
      `  --ratios=2,4,8,16     Comma-separated ratioBucketsPerOctave values (default: ${DEFAULT_RATIO_BUCKETS_PER_OCTAVE.join(",")})`,
      "  --ratio=<n>           Shorthand for a single ratioBucketsPerOctave value",
      "  --result-id=<id>      Use a specific z04 results entry instead of the latest one",
      "  --help                Show this help",
    ].join("\n"),
  )
}

function selectDatasetResult(
  allResults: readonly DatasetResult[],
  resultId?: string,
): DatasetResult {
  if (allResults.length === 0) {
    throw new Error("No z04 results were found.")
  }

  if (resultId === undefined) {
    return allResults[allResults.length - 1]!
  }

  const match = allResults.find((result) => result.id === resultId)
  if (match === undefined) {
    const knownIds = allResults.map((result) => result.id).join(", ")
    throw new Error(`Unknown --result-id "${resultId}". Known ids: ${knownIds}`)
  }

  return match
}

function loadUniqueNetSamples(
  rows: readonly DatasetResultRow[],
): LoadSamplesResult {
  const samples: ProjectedSample[] = []
  const missingProblemFiles: string[] = []
  let skippedSharedNetSamples = 0
  let skippedOutOfRangeAspectSamples = 0

  for (const row of rows) {
    const problemPath = join(PROBLEMS_DIR, row.fileName)
    if (!existsSync(problemPath)) {
      missingProblemFiles.push(row.fileName)
      continue
    }

    const rawProblem = JSON.parse(
      readFileSync(problemPath, "utf8"),
    ) as RawProblem
    if (!hasFullyUniqueNets(rawProblem)) {
      skippedSharedNetSamples += 1
      continue
    }
    if (
      getAspectRatio(rawProblem.width, rawProblem.height) >
      MAX_SUPPORTED_ASPECT_RATIO
    ) {
      skippedOutOfRangeAspectSamples += 1
      continue
    }

    samples.push({
      fileName: row.fileName,
      didSolve: row.didSolve,
      problem: buildProjectedProblem(rawProblem),
    })
  }

  return {
    samples,
    skippedSharedNetSamples,
    skippedOutOfRangeAspectSamples,
    missingProblemFiles,
  }
}

function hasFullyUniqueNets(problem: RawProblem): boolean {
  const countsByNet = new Map<string, number>()
  for (const point of problem.portPoints) {
    countsByNet.set(
      point.rootConnectionName,
      (countsByNet.get(point.rootConnectionName) ?? 0) + 1,
    )
  }

  for (const count of countsByNet.values()) {
    if (count !== 2) return false
  }

  return true
}

function getAspectRatio(width: number, height: number): number {
  const lo = Math.min(width, height)
  const hi = Math.max(width, height)
  return hi / lo
}

// Match the z04 dataset's nearest-edge perimeter projection for interior points.
function projectToPerimeterT(
  point: { x: number; y: number },
  xmin: number,
  xmax: number,
  ymin: number,
  ymax: number,
): number {
  const width = xmax - xmin
  const height = ymax - ymin
  const epsilon = 1e-6

  if (Math.abs(point.y - ymax) < epsilon) return point.x - xmin
  if (Math.abs(point.x - xmax) < epsilon) return width + (ymax - point.y)
  if (Math.abs(point.y - ymin) < epsilon)
    return width + height + (xmax - point.x)
  if (Math.abs(point.x - xmin) < epsilon)
    return 2 * width + height + (point.y - ymin)

  const distTop = Math.abs(point.y - ymax)
  const distRight = Math.abs(point.x - xmax)
  const distBottom = Math.abs(point.y - ymin)
  const distLeft = Math.abs(point.x - xmin)
  const minDist = Math.min(distTop, distRight, distBottom, distLeft)

  if (minDist === distTop) return Math.max(0, Math.min(width, point.x - xmin))
  if (minDist === distRight)
    return width + Math.max(0, Math.min(height, ymax - point.y))
  if (minDist === distBottom)
    return width + height + Math.max(0, Math.min(width, xmax - point.x))
  return 2 * width + height + Math.max(0, Math.min(height, point.y - ymin))
}

function buildProjectedProblem(problem: RawProblem): ProblemBuffers {
  const xmin = problem.center.x - problem.width / 2
  const xmax = problem.center.x + problem.width / 2
  const ymin = problem.center.y - problem.height / 2
  const ymax = problem.center.y + problem.height / 2
  const pointsByNet = new Map<string, RawPortPoint[]>()
  let maxZ = 0

  for (const point of problem.portPoints) {
    const points = pointsByNet.get(point.rootConnectionName) ?? []
    points.push(point)
    pointsByNet.set(point.rootConnectionName, points)
    if (point.z > maxZ) maxZ = point.z
  }

  const pairCount = pointsByNet.size
  const t1 = new Float64Array(pairCount)
  const t2 = new Float64Array(pairCount)
  const z1 = new Int32Array(pairCount)
  const z2 = new Int32Array(pairCount)
  const netOfPair = new Int32Array(pairCount)
  const netSizeOfPair = new Int32Array(pairCount)

  let writeIndex = 0
  for (const [netName, points] of pointsByNet) {
    if (points.length !== 2) {
      throw new Error(`Expected exactly two points for net "${netName}".`)
    }

    const first = points[0]!
    const second = points[1]!
    t1[writeIndex] = projectToPerimeterT(first, xmin, xmax, ymin, ymax)
    t2[writeIndex] = projectToPerimeterT(second, xmin, xmax, ymin, ymax)
    z1[writeIndex] = first.z | 0
    z2[writeIndex] = second.z | 0
    netOfPair[writeIndex] = writeIndex
    netSizeOfPair[writeIndex] = 1
    writeIndex += 1
  }

  return {
    width: problem.width,
    height: problem.height,
    depth: maxZ + 1,
    pairCount,
    netCount: pairCount,
    t1,
    t2,
    z1,
    z2,
    netOfPair,
    netSizeOfPair,
  }
}

function serializeWords(words: Float64Array): string {
  return Array.from(words, (value) => String(value)).join(",")
}

function analyzeParameters(
  samples: readonly ProjectedSample[],
  binsPerSide: number,
  ratioBucketsPerOctave: number,
): ParameterRow {
  const kc = new KeyComputer({ binsPerSide, ratioBucketsPerOctave })
  const buckets = new Map<
    string,
    { sampleCount: number; trueCount: number; falseCount: number }
  >()

  for (const sample of samples) {
    const key = kc.computeBaseKey(sample.problem)
    const bucketKey = serializeWords(key.words)
    const bucket = buckets.get(bucketKey) ?? {
      sampleCount: 0,
      trueCount: 0,
      falseCount: 0,
    }

    bucket.sampleCount += 1
    if (sample.didSolve) bucket.trueCount += 1
    else bucket.falseCount += 1

    buckets.set(bucketKey, bucket)
  }

  let collidingKeys = 0
  let collisionSamples = 0
  let mixedDidSolveKeys = 0
  let errorCollisions = 0

  for (const bucket of buckets.values()) {
    if (bucket.sampleCount > 1) {
      collidingKeys += 1
      collisionSamples += bucket.sampleCount
    }
    if (bucket.trueCount > 0 && bucket.falseCount > 0) {
      mixedDidSolveKeys += 1
      errorCollisions += Math.min(bucket.trueCount, bucket.falseCount)
    }
  }

  return {
    binsPerSide,
    ratioBucketsPerOctave,
    sampleCount: samples.length,
    uniqueKeys: buckets.size,
    collidingKeys,
    collisionSamples,
    mixedDidSolveKeys,
    errorCollisions,
  }
}

function formatTable(rows: readonly ParameterRow[]): string {
  const columns = [
    {
      header: "binsPerSide",
      get: (row: ParameterRow) => String(row.binsPerSide),
    },
    {
      header: "ratioBucketsPerOctave",
      get: (row: ParameterRow) => String(row.ratioBucketsPerOctave),
    },
    {
      header: "sampleCount",
      get: (row: ParameterRow) => String(row.sampleCount),
    },
    {
      header: "uniqueKeys",
      get: (row: ParameterRow) => String(row.uniqueKeys),
    },
    {
      header: "collidingKeys",
      get: (row: ParameterRow) => String(row.collidingKeys),
    },
    {
      header: "collisionSamples",
      get: (row: ParameterRow) => String(row.collisionSamples),
    },
    {
      header: "mixedDidSolveKeys",
      get: (row: ParameterRow) => String(row.mixedDidSolveKeys),
    },
    {
      header: "errorCollisions",
      get: (row: ParameterRow) => String(row.errorCollisions),
    },
  ]

  const widths = columns.map((column) =>
    Math.max(
      column.header.length,
      ...rows.map((row) => column.get(row).length),
    ),
  )

  const header = columns
    .map((column, index) => column.header.padEnd(widths[index]!))
    .join("  ")
  const divider = widths.map((width) => "-".repeat(width)).join("  ")
  const body = rows.map((row) =>
    columns
      .map((column, index) => column.get(row).padEnd(widths[index]!))
      .join("  "),
  )

  return [header, divider, ...body].join("\n")
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2))
  const selectedResult = selectDatasetResult(
    z04Results as readonly DatasetResult[],
    options.resultId,
  )
  const {
    samples,
    skippedSharedNetSamples,
    skippedOutOfRangeAspectSamples,
    missingProblemFiles,
  } = loadUniqueNetSamples(selectedResult.data)

  if (samples.length === 0) {
    throw new Error("No unique-net z04 samples were available after filtering.")
  }

  const rows = options.binsPerSide.flatMap((binsPerSide) =>
    options.ratioBucketsPerOctaveList.map((ratioBucketsPerOctave) =>
      analyzeParameters(samples, binsPerSide, ratioBucketsPerOctave),
    ),
  )

  console.log(`z04 results id: ${selectedResult.id}`)
  console.log(`usable unique-net samples: ${samples.length}`)
  console.log(`skipped shared-net samples: ${skippedSharedNetSamples}`)
  console.log(
    `skipped aspect-ratio > ${MAX_SUPPORTED_ASPECT_RATIO}: ${skippedOutOfRangeAspectSamples}`,
  )
  console.log(`missing problem files: ${missingProblemFiles.length}`)
  if (missingProblemFiles.length > 0) {
    console.log(`missing file names: ${missingProblemFiles.join(", ")}`)
  }
  console.log(
    "note: interior points are projected to the nearest perimeter edge using the z04 dataset's own perimeter rule.",
  )
  console.log(
    `note: only samples with aspect ratio between 1:${MAX_SUPPORTED_ASPECT_RATIO} and ${MAX_SUPPORTED_ASPECT_RATIO}:1 are included.`,
  )
  console.log(
    "note: errorCollisions sums min(trueCount, falseCount) per key bucket, so a collision only counts when same-key samples disagree on didSolve.",
  )
  console.log("")
  console.log(formatTable(rows))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
