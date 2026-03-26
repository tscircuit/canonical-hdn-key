interface PairRange {
  start: number
  end: number
  label: string
}

interface CliOptions {
  binsPerSide: number[]
  ratioBuckets: number[]
  depths: number[]
  pairRange: PairRange
}

interface ParameterRow {
  binsPerSide: number
  ratioBuckets: number
  depth: number
  pairCounts: string
  totalKeys: bigint
  totalKeysNoSameZReuse: bigint
}

interface GroupElement {
  mirror: boolean
  rotation: number
}

interface CycleCounts {
  one: number
  two: number
  four: number
}

interface PairCatalog {
  pairA: Uint32Array
  pairB: Uint32Array
}

interface SymmetryProfile {
  endpointCycleCountsByGroup: CycleCounts[]
  pairTypeCycleCountsByGroup: CycleCounts[]
}

const DEFAULT_BINS_PER_SIDE = [1, 2, 4, 8, 16, 32, 64]
const DEFAULT_RATIO_BUCKETS = [1, 2, 4, 8, 16, 32]
const DEFAULT_DEPTHS = [2]
const DEFAULT_PAIR_COUNT_MIN = 3
const DEFAULT_PAIR_COUNT_MAX = 8
const GROUP_ORDER = 8n
const D4_GROUP: readonly GroupElement[] = [
  { mirror: false, rotation: 0 },
  { mirror: false, rotation: 1 },
  { mirror: false, rotation: 2 },
  { mirror: false, rotation: 3 },
  { mirror: true, rotation: 0 },
  { mirror: true, rotation: 1 },
  { mirror: true, rotation: 2 },
  { mirror: true, rotation: 3 },
]

const pairCatalogCache = new Map<number, PairCatalog>()
const symmetryProfileCache = new Map<string, SymmetryProfile>()

function makePairRange(start: number, end: number): PairRange {
  return {
    start,
    end,
    label: `[${start},${end}]`,
  }
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    binsPerSide: [...DEFAULT_BINS_PER_SIDE],
    ratioBuckets: [...DEFAULT_RATIO_BUCKETS],
    depths: [...DEFAULT_DEPTHS],
    pairRange: makePairRange(DEFAULT_PAIR_COUNT_MIN, DEFAULT_PAIR_COUNT_MAX),
  }

  let pairCountMin = DEFAULT_PAIR_COUNT_MIN
  let pairCountMax = DEFAULT_PAIR_COUNT_MAX

  for (const arg of argv) {
    if (arg === "--help") {
      printHelp()
      process.exit(0)
    }

    if (arg.startsWith("--bins=")) {
      options.binsPerSide = parsePositiveIntegerList(
        arg.slice("--bins=".length),
        "bins",
      )
      continue
    }

    if (arg.startsWith("--ratio=")) {
      options.ratioBuckets = [
        parsePositiveInteger(arg.slice("--ratio=".length), "ratio"),
      ]
      continue
    }

    if (arg.startsWith("--ratios=")) {
      options.ratioBuckets = parsePositiveIntegerList(
        arg.slice("--ratios=".length),
        "ratios",
      )
      continue
    }

    if (arg.startsWith("--depth=")) {
      options.depths = [
        parsePositiveInteger(arg.slice("--depth=".length), "depth"),
      ]
      continue
    }

    if (arg.startsWith("--depths=")) {
      options.depths = parsePositiveIntegerList(
        arg.slice("--depths=".length),
        "depths",
      )
      continue
    }

    if (arg.startsWith("--pair-count-min=")) {
      pairCountMin = parsePositiveInteger(
        arg.slice("--pair-count-min=".length),
        "pair-count-min",
      )
      continue
    }

    if (arg.startsWith("--pair-count-max=")) {
      pairCountMax = parsePositiveInteger(
        arg.slice("--pair-count-max=".length),
        "pair-count-max",
      )
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  if (pairCountMin > pairCountMax) {
    throw new Error(
      `Expected --pair-count-min <= --pair-count-max, received ${pairCountMin} > ${pairCountMax}.`,
    )
  }

  options.pairRange = makePairRange(pairCountMin, pairCountMax)
  return options
}

function parsePositiveIntegerList(value: string, label: string): number[] {
  const out = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => parsePositiveInteger(part, label))

  if (out.length === 0) {
    throw new Error(`Expected at least one integer for --${label}.`)
  }

  return [...new Set(out)].sort((a, b) => a - b)
}

function parsePositiveInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `Expected --${label} to be a positive integer, received "${value}".`,
    )
  }

  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(
      `Expected --${label} to be a positive integer, received "${value}".`,
    )
  }

  return parsed
}

function printHelp(): void {
  console.log(
    [
      "Usage: bun run scripts/collision-testing/print-theoretical-keyspace.ts [options]",
      "",
      "This script counts the theoretical base-key space with a max aspect ratio of 4:1.",
      "It does not use any dataset samples.",
      "Counts quotient by the same 8-way dihedral symmetry used by KeyComputer.",
      "",
      "Options:",
      `  --bins=1,2,4,8,16,32,64      Comma-separated binsPerSide values (default: ${DEFAULT_BINS_PER_SIDE.join(",")})`,
      `  --ratios=1,2,4,8,16,32       Comma-separated ratioBuckets values (default: ${DEFAULT_RATIO_BUCKETS.join(",")})`,
      "  --ratio=<n>                  Shorthand for a single ratioBuckets value",
      `  --depths=2                   Comma-separated depth values (default: ${DEFAULT_DEPTHS.join(",")})`,
      "  --depth=<n>                  Shorthand for a single depth value",
      `  --pair-count-min=3           Inclusive pair-count range start (default: ${DEFAULT_PAIR_COUNT_MIN})`,
      `  --pair-count-max=8           Inclusive pair-count range end (default: ${DEFAULT_PAIR_COUNT_MAX})`,
      "  --help                       Show this help",
    ].join("\n"),
  )
}

function modPositive(value: number, modulus: number): number {
  const out = value % modulus
  return out < 0 ? out + modulus : out
}

function powBigInt(base: bigint, exponent: number): bigint {
  let out = 1n
  for (let i = 0; i < exponent; i += 1) out *= base
  return out
}

function chooseBigInt(n: bigint, k: bigint): bigint {
  if (k < 0n || k > n) return 0n

  let kk = k
  if (kk > n - kk) kk = n - kk

  let out = 1n
  for (let i = 1n; i <= kk; i += 1n) {
    out = (out * (n - kk + i)) / i
  }

  return out
}

function pairingCount(pairCount: number): bigint {
  let out = 1n
  for (let value = 1; value < pairCount * 2; value += 2) {
    out *= BigInt(value)
  }
  return out
}

function starsAndBars(bucketCount: number, picks: number): bigint {
  if (picks === 0) return 1n
  if (bucketCount === 0) return 0n
  return chooseBigInt(BigInt(bucketCount + picks - 1), BigInt(picks))
}

function getAspectBucketCount(ratioBuckets: number): bigint {
  return BigInt(2 * ratioBuckets + 1)
}

function getEndpointStateCount(binsPerSide: number, depth: number): number {
  return 4 * binsPerSide * depth
}

function getPairCatalog(endpointStateCount: number): PairCatalog {
  const cached = pairCatalogCache.get(endpointStateCount)
  if (cached !== undefined) return cached

  const pairTypeCount = (endpointStateCount * (endpointStateCount + 1)) / 2
  const pairA = new Uint32Array(pairTypeCount)
  const pairB = new Uint32Array(pairTypeCount)

  let writeIndex = 0
  for (let a = 0; a < endpointStateCount; a += 1) {
    for (let b = a; b < endpointStateCount; b += 1) {
      pairA[writeIndex] = a
      pairB[writeIndex] = b
      writeIndex += 1
    }
  }

  const out = { pairA, pairB }
  pairCatalogCache.set(endpointStateCount, out)
  return out
}

function pairIndex(a: number, b: number, endpointStateCount: number): number {
  return a * endpointStateCount - (a * (a - 1)) / 2 + (b - a)
}

function transformPosition(
  q: number,
  binsPerSide: number,
  mirror: boolean,
  rotation: number,
): number {
  const modulus = binsPerSide * 4
  const shift = rotation * binsPerSide
  return mirror
    ? modPositive(shift - q, modulus)
    : modPositive(q + shift, modulus)
}

function buildEndpointPermutation(
  binsPerSide: number,
  depth: number,
  group: GroupElement,
): Uint32Array {
  const modulus = binsPerSide * 4
  const endpointStateCount = modulus * depth
  const out = new Uint32Array(endpointStateCount)

  for (let z = 0; z < depth; z += 1) {
    const zOffset = z * modulus
    for (let q = 0; q < modulus; q += 1) {
      out[zOffset + q] =
        zOffset +
        transformPosition(q, binsPerSide, group.mirror, group.rotation)
    }
  }

  return out
}

function getCycleCountsFromPermutation(permutation: Uint32Array): CycleCounts {
  const visited = new Uint8Array(permutation.length)
  const out: CycleCounts = { one: 0, two: 0, four: 0 }

  for (let start = 0; start < permutation.length; start += 1) {
    if (visited[start] !== 0) continue

    let cycleLength = 0
    let cursor = start
    do {
      visited[cursor] = 1
      cycleLength += 1
      cursor = permutation[cursor]!
    } while (cursor !== start)

    if (cycleLength === 1) out.one += 1
    else if (cycleLength === 2) out.two += 1
    else if (cycleLength === 4) out.four += 1
    else throw new Error(`Unexpected cycle length ${cycleLength}.`)
  }

  return out
}

function getPairTypeCycleCounts(
  endpointPermutation: Uint32Array,
  pairCatalog: PairCatalog,
): CycleCounts {
  const endpointStateCount = endpointPermutation.length
  const pairTypeCount = pairCatalog.pairA.length
  const visited = new Uint8Array(pairTypeCount)
  const out: CycleCounts = { one: 0, two: 0, four: 0 }

  for (let start = 0; start < pairTypeCount; start += 1) {
    if (visited[start] !== 0) continue

    let cycleLength = 0
    let cursor = start
    while (visited[cursor] === 0) {
      visited[cursor] = 1
      cycleLength += 1

      let a = endpointPermutation[pairCatalog.pairA[cursor]!]!
      let b = endpointPermutation[pairCatalog.pairB[cursor]!]!
      if (a > b) {
        const temp = a
        a = b
        b = temp
      }

      cursor = pairIndex(a, b, endpointStateCount)
    }

    if (cycleLength === 1) out.one += 1
    else if (cycleLength === 2) out.two += 1
    else if (cycleLength === 4) out.four += 1
    else throw new Error(`Unexpected pair-type cycle length ${cycleLength}.`)
  }

  return out
}

function getSymmetryProfile(
  binsPerSide: number,
  depth: number,
): SymmetryProfile {
  const cacheKey = `${binsPerSide}:${depth}`
  const cached = symmetryProfileCache.get(cacheKey)
  if (cached !== undefined) return cached

  const endpointStateCount = getEndpointStateCount(binsPerSide, depth)
  const pairCatalog = getPairCatalog(endpointStateCount)
  const endpointCycleCountsByGroup: CycleCounts[] = []
  const pairTypeCycleCountsByGroup: CycleCounts[] = []

  for (const group of D4_GROUP) {
    const endpointPermutation = buildEndpointPermutation(
      binsPerSide,
      depth,
      group,
    )
    endpointCycleCountsByGroup.push(
      getCycleCountsFromPermutation(endpointPermutation),
    )
    pairTypeCycleCountsByGroup.push(
      getPairTypeCycleCounts(endpointPermutation, pairCatalog),
    )
  }

  const out = {
    endpointCycleCountsByGroup,
    pairTypeCycleCountsByGroup,
  }
  symmetryProfileCache.set(cacheKey, out)
  return out
}

function countFixedMultisets(
  cycleCounts: CycleCounts,
  pairCount: number,
): bigint {
  let out = 0n

  for (let useFour = 0; useFour * 4 <= pairCount; useFour += 1) {
    for (let useTwo = 0; useFour * 4 + useTwo * 2 <= pairCount; useTwo += 1) {
      const useOne = pairCount - useFour * 4 - useTwo * 2
      out +=
        starsAndBars(cycleCounts.one, useOne) *
        starsAndBars(cycleCounts.two, useTwo) *
        starsAndBars(cycleCounts.four, useFour)
    }
  }

  return out
}

function countFixedLengthOneMatchings(
  fixedVertexCycles: number,
  edgeCount: number,
): bigint {
  if (edgeCount * 2 > fixedVertexCycles) return 0n
  return (
    chooseBigInt(BigInt(fixedVertexCycles), BigInt(edgeCount * 2)) *
    pairingCount(edgeCount)
  )
}

function countFixedLengthTwoMatchings(
  twoCycles: number,
  edgeCount: number,
): bigint {
  if (edgeCount > twoCycles) return 0n

  let out = 0n
  for (
    let pairedCyclePairs = 0;
    pairedCyclePairs * 2 <= edgeCount;
    pairedCyclePairs += 1
  ) {
    const internalCycles = edgeCount - pairedCyclePairs * 2
    if (internalCycles + pairedCyclePairs * 2 > twoCycles) continue

    out +=
      chooseBigInt(BigInt(twoCycles), BigInt(internalCycles)) *
      chooseBigInt(
        BigInt(twoCycles - internalCycles),
        BigInt(pairedCyclePairs * 2),
      ) *
      pairingCount(pairedCyclePairs) *
      powBigInt(2n, pairedCyclePairs)
  }

  return out
}

function countFixedLengthFourMatchings(
  fourCycles: number,
  edgeCount: number,
): bigint {
  let out = 0n

  for (
    let pairedCyclePairs = 0;
    pairedCyclePairs * 4 <= edgeCount;
    pairedCyclePairs += 1
  ) {
    const remainingEdges = edgeCount - pairedCyclePairs * 4
    if ((remainingEdges & 1) !== 0) continue

    const internalCycles = remainingEdges / 2
    if (internalCycles + pairedCyclePairs * 2 > fourCycles) continue

    out +=
      chooseBigInt(BigInt(fourCycles), BigInt(internalCycles)) *
      chooseBigInt(
        BigInt(fourCycles - internalCycles),
        BigInt(pairedCyclePairs * 2),
      ) *
      pairingCount(pairedCyclePairs) *
      powBigInt(4n, pairedCyclePairs)
  }

  return out
}

function countFixedNoReuseMatchings(
  cycleCounts: CycleCounts,
  pairCount: number,
): bigint {
  let out = 0n

  for (let edgesFromFour = 0; edgesFromFour <= pairCount; edgesFromFour += 1) {
    const countFour = countFixedLengthFourMatchings(
      cycleCounts.four,
      edgesFromFour,
    )
    if (countFour === 0n) continue

    for (
      let edgesFromTwo = 0;
      edgesFromTwo + edgesFromFour <= pairCount;
      edgesFromTwo += 1
    ) {
      const countTwo = countFixedLengthTwoMatchings(
        cycleCounts.two,
        edgesFromTwo,
      )
      if (countTwo === 0n) continue

      const edgesFromOne = pairCount - edgesFromFour - edgesFromTwo
      const countOne = countFixedLengthOneMatchings(
        cycleCounts.one,
        edgesFromOne,
      )
      if (countOne === 0n) continue

      out += countFour * countTwo * countOne
    }
  }

  return out
}

function countSymmetryReducedPairMultisets(
  profile: SymmetryProfile,
  pairCount: number,
): bigint {
  let fixedTotal = 0n
  for (const cycleCounts of profile.pairTypeCycleCountsByGroup) {
    fixedTotal += countFixedMultisets(cycleCounts, pairCount)
  }

  if (fixedTotal % GROUP_ORDER !== 0n) {
    throw new Error("Pair-multiset Burnside total was not divisible by 8.")
  }

  return fixedTotal / GROUP_ORDER
}

function countSymmetryReducedNoReuseMatchings(
  profile: SymmetryProfile,
  pairCount: number,
): bigint {
  let fixedTotal = 0n
  for (const cycleCounts of profile.endpointCycleCountsByGroup) {
    fixedTotal += countFixedNoReuseMatchings(cycleCounts, pairCount)
  }

  if (fixedTotal % GROUP_ORDER !== 0n) {
    throw new Error("No-reuse Burnside total was not divisible by 8.")
  }

  return fixedTotal / GROUP_ORDER
}

function analyzeParameters(
  binsPerSide: number,
  ratioBuckets: number,
  depth: number,
  pairRange: PairRange,
): ParameterRow {
  const profile = getSymmetryProfile(binsPerSide, depth)
  const aspectBucketCount = getAspectBucketCount(ratioBuckets)

  let totalKeys = 0n
  let totalKeysNoSameZReuse = 0n

  for (
    let pairCount = pairRange.start;
    pairCount <= pairRange.end;
    pairCount += 1
  ) {
    totalKeys +=
      aspectBucketCount * countSymmetryReducedPairMultisets(profile, pairCount)
    totalKeysNoSameZReuse +=
      aspectBucketCount *
      countSymmetryReducedNoReuseMatchings(profile, pairCount)
  }

  return {
    binsPerSide,
    ratioBuckets,
    depth,
    pairCounts: pairRange.label,
    totalKeys,
    totalKeysNoSameZReuse,
  }
}

function formatTable(rows: readonly ParameterRow[]): string {
  const columns = [
    {
      header: "binsPerSide",
      get: (row: ParameterRow) => String(row.binsPerSide),
    },
    {
      header: "ratioBuckets",
      get: (row: ParameterRow) => String(row.ratioBuckets),
    },
    {
      header: "depth",
      get: (row: ParameterRow) => String(row.depth),
    },
    {
      header: "pairCounts",
      get: (row: ParameterRow) => row.pairCounts,
    },
    {
      header: "totalKeys",
      get: (row: ParameterRow) => row.totalKeys.toString(),
    },
    {
      header: "totalKeysNoSameZReuse",
      get: (row: ParameterRow) => row.totalKeysNoSameZReuse.toString(),
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
  const rows = options.binsPerSide.flatMap((binsPerSide) =>
    options.ratioBuckets.flatMap((ratioBuckets) =>
      options.depths.map((depth) =>
        analyzeParameters(binsPerSide, ratioBuckets, depth, options.pairRange),
      ),
    ),
  )

  console.log(formatTable(rows))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
