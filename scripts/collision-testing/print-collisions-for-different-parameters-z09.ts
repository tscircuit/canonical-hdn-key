import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { KeyComputer, type ProblemBuffers } from "../../lib/index.ts"

interface RawPortPoint {
  x: number
  y: number
  z: number
  rootConnectionName: string
}

interface RawSample {
  center: { x: number; y: number }
  width: number
  height: number
  portPoints: RawPortPoint[]
  solvable: boolean
}

interface ProjectedSample {
  fileName: string
  width: number
  height: number
  area: number
  problem: ProblemBuffers
}

interface ParameterRow {
  binsPerSide: number
  ratioBucketsPerOctave: number
  trainKeys: number
  collidingKeys: number
  collisionSamples: number
  validationHits: number
  misses: number
  missPercent: number
  errorCollisions: number
  accuracyPercent: number | null
}

interface LoadSamplesResult {
  samples: ProjectedSample[]
  skippedSharedNetSamples: number
  skippedOutOfRangeAspectSamples: number
  skippedTooManyPairSamples: number
  skippedRequestedPairCountSamples: number
  sampleFileCount: number
  solvableTrueSamples: number
  solvableFalseSamples: number
}

interface CliOptions {
  binsPerSide: number[]
  ratioBucketsPerOctaveList: number[]
  split: Split
  pairCount?: number
}

interface Split {
  trainWeight: number
  validationWeight: number
  label: string
}

const DEFAULT_BINS_PER_SIDE = [1, 2, 4, 8, 16, 32, 64]
const DEFAULT_RATIO_BUCKETS_PER_OCTAVE = [1, 2, 4, 8, 16, 32]
const MAX_SUPPORTED_ASPECT_RATIO = 4
const MAX_INCLUDED_PAIR_COUNT = 7
const FAILING_SET_SHRINK_FRACTION = 0.1
const FAILING_SET_LINEAR_SCALE = 1 - FAILING_SET_SHRINK_FRACTION
const FAILING_SET_AREA_SCALE =
  FAILING_SET_LINEAR_SCALE * FAILING_SET_LINEAR_SCALE
const DATASET_ROOT = fileURLToPath(
  new URL("../../node_modules/dataset-z09/", import.meta.url),
)
const SAMPLES_DIR = join(DATASET_ROOT, "samples")

function parseCliOptions(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    binsPerSide: [...DEFAULT_BINS_PER_SIDE],
    ratioBucketsPerOctaveList: [...DEFAULT_RATIO_BUCKETS_PER_OCTAVE],
    split: parseSplit("70/30"),
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!

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

    if (arg.startsWith("--split=")) {
      options.split = parseSplit(arg.slice("--split=".length))
      continue
    }

    if (arg.startsWith("--pair-count=")) {
      options.pairCount = parsePairCount(
        arg.slice("--pair-count=".length),
        "pair-count",
      )
      continue
    }

    if (arg === "--pair-count") {
      const next = argv[index + 1]
      if (next === undefined) {
        throw new Error("Expected an integer after --pair-count.")
      }
      options.pairCount = parsePairCount(next, "pair-count")
      index += 1
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

function parsePairCount(value: string, label: string): number {
  const pairCount = parseNonNegativeInteger(value, label)
  if (pairCount < 1 || pairCount > MAX_INCLUDED_PAIR_COUNT) {
    throw new Error(
      `Expected --${label} to be between 1 and ${MAX_INCLUDED_PAIR_COUNT}, received "${value}".`,
    )
  }
  return pairCount
}

function parseSplit(value: string): Split {
  const match = value.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/)
  if (!match) {
    throw new Error(
      `Expected --split in the form train/validation, received "${value}".`,
    )
  }

  const trainWeight = Number(match[1])
  const validationWeight = Number(match[2])

  if (
    !Number.isFinite(trainWeight) ||
    !Number.isFinite(validationWeight) ||
    trainWeight <= 0 ||
    validationWeight <= 0
  ) {
    throw new Error(`Expected positive split weights, received "${value}".`)
  }

  return {
    trainWeight,
    validationWeight,
    label: `${trainWeight}/${validationWeight}`,
  }
}

function printHelp(): void {
  console.log(
    [
      "Usage: bun run scripts/collision-testing/print-collisions-for-different-parameters-z09.ts [options]",
      "",
      "Options:",
      `  --bins=1,2,4,8,16,32,64   Comma-separated binsPerSide values (default: ${DEFAULT_BINS_PER_SIDE.join(",")})`,
      `  --ratios=1,2,4,8,16,32    Comma-separated ratioBuckets values (default: ${DEFAULT_RATIO_BUCKETS_PER_OCTAVE.join(",")})`,
      "  --ratio=<n>           Shorthand for a single ratioBuckets value",
      "  --split=70/30         Train/validation split over filtered samples",
      `  --pair-count=4        Only include samples with exactly this many point pairs (1-${MAX_INCLUDED_PAIR_COUNT})`,
      "  --help                Show this help",
    ].join("\n"),
  )
}

function loadFilteredSamples(options: CliOptions): LoadSamplesResult {
  const sampleFileNames = readdirSync(SAMPLES_DIR)
    .filter((name) => /^sample\d+\.json$/.test(name))
    .sort()

  if (sampleFileNames.length === 0) {
    throw new Error("No dataset-z09 sample files were found.")
  }

  const samples: ProjectedSample[] = []
  let skippedSharedNetSamples = 0
  let skippedOutOfRangeAspectSamples = 0
  let skippedTooManyPairSamples = 0
  let skippedRequestedPairCountSamples = 0
  let solvableTrueSamples = 0
  let solvableFalseSamples = 0

  for (const fileName of sampleFileNames) {
    const samplePath = join(SAMPLES_DIR, fileName)
    const rawSample = JSON.parse(readFileSync(samplePath, "utf8")) as RawSample

    if (rawSample.solvable) solvableTrueSamples += 1
    else solvableFalseSamples += 1

    if (!hasFullyUniqueNets(rawSample)) {
      skippedSharedNetSamples += 1
      continue
    }
    if (
      getAspectRatio(rawSample.width, rawSample.height) >
      MAX_SUPPORTED_ASPECT_RATIO
    ) {
      skippedOutOfRangeAspectSamples += 1
      continue
    }
    const pairCount = getUniqueNetPairCount(rawSample)
    if (pairCount > MAX_INCLUDED_PAIR_COUNT) {
      skippedTooManyPairSamples += 1
      continue
    }
    if (options.pairCount !== undefined && pairCount !== options.pairCount) {
      skippedRequestedPairCountSamples += 1
      continue
    }

    samples.push({
      fileName,
      width: rawSample.width,
      height: rawSample.height,
      area: rawSample.width * rawSample.height,
      problem: buildProjectedProblem(rawSample),
    })
  }

  return {
    samples,
    skippedSharedNetSamples,
    skippedOutOfRangeAspectSamples,
    skippedTooManyPairSamples,
    skippedRequestedPairCountSamples,
    sampleFileCount: sampleFileNames.length,
    solvableTrueSamples,
    solvableFalseSamples,
  }
}

function splitSamples(
  samples: readonly ProjectedSample[],
  split: Split,
): {
  trainingSamples: ProjectedSample[]
  validationSamples: ProjectedSample[]
} {
  const totalWeight = split.trainWeight + split.validationWeight
  let trainingCount = Math.floor(
    (samples.length * split.trainWeight) / totalWeight,
  )

  if (samples.length > 1) {
    trainingCount = Math.max(1, Math.min(samples.length - 1, trainingCount))
  }

  return {
    trainingSamples: samples.slice(0, trainingCount),
    validationSamples: samples.slice(trainingCount),
  }
}

function hasFullyUniqueNets(problem: RawSample): boolean {
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

function getUniqueNetPairCount(problem: RawSample): number {
  return problem.portPoints.length / 2
}

// Map any point to the nearest perimeter position before quantization.
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

function buildProjectedProblem(problem: RawSample): ProblemBuffers {
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

function getFailingArea(sample: ProjectedSample): number {
  return sample.area * FAILING_SET_AREA_SCALE
}

function analyzeParameters(
  trainingSamples: readonly ProjectedSample[],
  validationSamples: readonly ProjectedSample[],
  binsPerSide: number,
  ratioBucketsPerOctave: number,
): ParameterRow {
  const kc = new KeyComputer({ binsPerSide, ratioBucketsPerOctave })
  const buckets = new Map<string, { sampleCount: number; storedArea: number }>()

  for (const sample of trainingSamples) {
    const key = kc.computeBaseKey(sample.problem)
    const bucketKey = serializeWords(key.words)
    const bucket = buckets.get(bucketKey) ?? {
      sampleCount: 0,
      storedArea: sample.area,
    }

    bucket.sampleCount += 1
    if (sample.area < bucket.storedArea) bucket.storedArea = sample.area

    buckets.set(bucketKey, bucket)
  }

  let collidingKeys = 0
  let collisionSamples = 0

  for (const bucket of buckets.values()) {
    if (bucket.sampleCount <= 1) continue

    collidingKeys += 1
    collisionSamples += bucket.sampleCount
  }

  let validationHits = 0
  let misses = 0
  let errorCollisions = 0

  for (const sample of validationSamples) {
    const key = kc.computeBaseKey(sample.problem)
    const bucket = buckets.get(serializeWords(key.words))

    if (bucket === undefined) {
      misses += 1
      continue
    }

    validationHits += 1
    if (bucket.storedArea <= getFailingArea(sample)) {
      errorCollisions += 1
    }
  }

  return {
    binsPerSide,
    ratioBucketsPerOctave,
    trainKeys: buckets.size,
    collidingKeys,
    collisionSamples,
    validationHits,
    misses,
    missPercent:
      validationSamples.length > 0
        ? (misses / validationSamples.length) * 100
        : 0,
    errorCollisions,
    accuracyPercent:
      validationHits > 0 ? (1 - errorCollisions / validationHits) * 100 : null,
  }
}

function formatPercent(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(2)}%`
}

function formatTable(rows: readonly ParameterRow[]): string {
  const columns = [
    {
      header: "binsPerSide",
      get: (row: ParameterRow) => String(row.binsPerSide),
    },
    {
      header: "ratioBuckets",
      get: (row: ParameterRow) => String(row.ratioBucketsPerOctave),
    },
    {
      header: "trainKeys",
      get: (row: ParameterRow) => String(row.trainKeys),
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
      header: "validationHits",
      get: (row: ParameterRow) => String(row.validationHits),
    },
    {
      header: "misses",
      get: (row: ParameterRow) => String(row.misses),
    },
    {
      header: "missPct",
      get: (row: ParameterRow) => formatPercent(row.missPercent),
    },
    {
      header: "errorCollisions",
      get: (row: ParameterRow) => String(row.errorCollisions),
    },
    {
      header: "accuracy",
      get: (row: ParameterRow) => formatPercent(row.accuracyPercent),
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
  const {
    samples,
    skippedSharedNetSamples,
    skippedOutOfRangeAspectSamples,
    skippedTooManyPairSamples,
    skippedRequestedPairCountSamples,
    sampleFileCount,
    solvableTrueSamples,
    solvableFalseSamples,
  } = loadFilteredSamples(options)

  if (samples.length === 0) {
    throw new Error("No dataset-z09 samples were available after filtering.")
  }

  const { trainingSamples, validationSamples } = splitSamples(
    samples,
    options.split,
  )

  const rows = options.binsPerSide.flatMap((binsPerSide) =>
    options.ratioBucketsPerOctaveList.map((ratioBucketsPerOctave) =>
      analyzeParameters(
        trainingSamples,
        validationSamples,
        binsPerSide,
        ratioBucketsPerOctave,
      ),
    ),
  )

  console.log("dataset: dataset-z09")
  console.log(`sample files: ${sampleFileCount}`)
  console.log(`solvable=true samples: ${solvableTrueSamples}`)
  console.log(`solvable=false samples: ${solvableFalseSamples}`)
  console.log(`usable samples after filters: ${samples.length}`)
  console.log(`split: ${options.split.label}`)
  console.log(`training samples: ${trainingSamples.length}`)
  console.log(`validation samples: ${validationSamples.length}`)
  console.log(`skipped shared-net samples: ${skippedSharedNetSamples}`)
  console.log(
    `skipped aspect-ratio > ${MAX_SUPPORTED_ASPECT_RATIO}: ${skippedOutOfRangeAspectSamples}`,
  )
  console.log(`skipped point pairs >= 8: ${skippedTooManyPairSamples}`)
  if (options.pairCount !== undefined) {
    console.log(
      `skipped point pairs != ${options.pairCount}: ${skippedRequestedPairCountSamples}`,
    )
  }
  console.log(
    "note: port points are mapped onto the nearest perimeter edge before binning.",
  )
  console.log(
    `note: only samples with aspect ratio between 1:${MAX_SUPPORTED_ASPECT_RATIO} and ${MAX_SUPPORTED_ASPECT_RATIO}:1 are included.`,
  )
  console.log(
    `note: only samples with fewer than ${MAX_INCLUDED_PAIR_COUNT + 1} point pairs are included.`,
  )
  if (options.pairCount !== undefined) {
    console.log(
      `note: this run is further restricted to samples with exactly ${options.pairCount} point pairs.`,
    )
  }
  console.log("note: size means node area (width * height).")
  console.log(
    `note: the failing set is built by shrinking each validation node by ${(FAILING_SET_SHRINK_FRACTION * 100).toFixed(0)}% in width and height.`,
  )
  console.log(
    "note: training stores the minimum area seen for each cache key; validation is an error collision when the recalled training area is at or below the failing-set area.",
  )
  console.log("")
  console.log(formatTable(rows))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
