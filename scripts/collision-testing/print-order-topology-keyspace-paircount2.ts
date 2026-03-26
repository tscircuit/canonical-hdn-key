interface CliOptions {
  binsPerSide: number[]
  depths: number[]
  pairCounts: number[]
  showClasses: boolean
}

interface ParameterRow {
  binsPerSide: number
  depth: number
  pairCount: number
  currentBaseKeyClassesAll: bigint
  topologyClassesAll: number
  topologyClassesDistinctQOnly: number
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
  pairTypeCycleCountsByGroup: CycleCounts[]
}

interface TopologyCountResult {
  all: number
  distinctQOnly: number
  distinctQSignatures?: string[]
}

const DEFAULT_BINS_PER_SIDE = [1, 2, 4]
const DEFAULT_DEPTHS = [2]
const DEFAULT_PAIR_COUNTS = [2, 3, 4]
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
const topologyCountCache = new Map<string, TopologyCountResult>()
const compositionCache = new Map<string, number[][]>()
const matchingCache = new Map<number, Uint8Array[]>()

function parseCliOptions(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    binsPerSide: [...DEFAULT_BINS_PER_SIDE],
    depths: [...DEFAULT_DEPTHS],
    pairCounts: [...DEFAULT_PAIR_COUNTS],
    showClasses: false,
  }

  for (const arg of argv) {
    if (arg === "--help") {
      printHelp()
      process.exit(0)
    }

    if (arg === "--show-classes") {
      options.showClasses = true
      continue
    }

    if (arg.startsWith("--bins=")) {
      options.binsPerSide = parsePositiveIntegerList(
        arg.slice("--bins=".length),
        "bins",
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

    if (arg.startsWith("--pair-count=")) {
      options.pairCounts = [
        parsePositiveInteger(arg.slice("--pair-count=".length), "pair-count"),
      ]
      continue
    }

    if (arg.startsWith("--pair-counts=")) {
      options.pairCounts = parsePositiveIntegerList(
        arg.slice("--pair-counts=".length),
        "pair-counts",
      )
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  if (options.showClasses && options.binsPerSide.length !== 1) {
    throw new Error("--show-classes expects exactly one binsPerSide value.")
  }

  if (options.showClasses && options.depths.length !== 1) {
    throw new Error("--show-classes expects exactly one depth value.")
  }

  if (options.showClasses && options.pairCounts.length !== 1) {
    throw new Error("--show-classes expects exactly one pairCount value.")
  }

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
      "Usage: bun run scripts/collision-testing/print-order-topology-keyspace-paircount2.ts [options]",
      "",
      "Compares the current D4-reduced base-key count against a coarser",
      "boundary order-topology count that ignores absolute boundary spacing.",
      "",
      "The current base-key count is exact and uses the same Burnside math as",
      "print-theoretical-keyspace.ts, but without the aspect-ratio multiplier.",
      "",
      "The topology count is exact for the abstract boundary-order quotient and",
      "is reported both for all cases and for the distinct-q-only cases where",
      "all 2*pairCount endpoints occupy different boundary positions.",
      "",
      "Options:",
      `  --bins=1,2,4               Comma-separated binsPerSide values (default: ${DEFAULT_BINS_PER_SIDE.join(",")})`,
      `  --depths=2                 Comma-separated depth values (default: ${DEFAULT_DEPTHS.join(",")})`,
      `  --pair-counts=2,3,4        Comma-separated pairCount values (default: ${DEFAULT_PAIR_COUNTS.join(",")})`,
      "  --depth=<n>                Shorthand for a single depth value",
      "  --pair-count=<n>           Shorthand for a single pairCount value",
      "  --show-classes             Print distinct-q topology signatures",
      "  --help                     Show this help",
    ].join("\n"),
  )
}

function modPositive(value: number, modulus: number): number {
  const out = value % modulus
  return out < 0 ? out + modulus : out
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

function starsAndBars(bucketCount: number, picks: number): bigint {
  if (picks === 0) return 1n
  if (bucketCount === 0) return 0n
  return chooseBigInt(BigInt(bucketCount + picks - 1), BigInt(picks))
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

  let write = 0
  for (let a = 0; a < endpointStateCount; a += 1) {
    for (let b = a; b < endpointStateCount; b += 1) {
      pairA[write] = a
      pairB[write] = b
      write += 1
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
  const pairTypeCycleCountsByGroup: CycleCounts[] = []

  for (const group of D4_GROUP) {
    const endpointPermutation = buildEndpointPermutation(
      binsPerSide,
      depth,
      group,
    )
    pairTypeCycleCountsByGroup.push(
      getPairTypeCycleCounts(endpointPermutation, pairCatalog),
    )
  }

  const out = { pairTypeCycleCountsByGroup }
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

function compareNumberArrays(
  a: readonly number[],
  b: readonly number[],
): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    if (a[i]! < b[i]!) return -1
    if (a[i]! > b[i]!) return 1
  }
  return a.length - b.length
}

function getCompositions(total: number, maxParts: number): number[][] {
  const cacheKey = `${total}:${maxParts}`
  const cached = compositionCache.get(cacheKey)
  if (cached !== undefined) return cached

  const out: number[][] = []
  const prefix = new Array<number>(total)

  const recurse = (
    remaining: number,
    partsLeft: number,
    depth: number,
  ): void => {
    if (partsLeft === 0) {
      if (remaining === 0) out.push(prefix.slice(0, depth))
      return
    }

    const minValue = 1
    const maxValue = remaining - (partsLeft - 1)
    for (let value = minValue; value <= maxValue; value += 1) {
      prefix[depth] = value
      recurse(remaining - value, partsLeft - 1, depth + 1)
    }
  }

  for (
    let partCount = 1;
    partCount <= Math.min(total, maxParts);
    partCount += 1
  ) {
    recurse(total, partCount, 0)
  }

  compositionCache.set(cacheKey, out)
  return out
}

function getPairIdBySlotList(slotCount: number): Uint8Array[] {
  const cached = matchingCache.get(slotCount)
  if (cached !== undefined) return cached

  const out: Uint8Array[] = []
  const pairIdBySlot = new Uint8Array(slotCount)
  const used = new Uint8Array(slotCount)

  const recurse = (nextPairId: number): void => {
    let firstUnused = -1
    for (let i = 0; i < slotCount; i += 1) {
      if (used[i] === 0) {
        firstUnused = i
        break
      }
    }

    if (firstUnused === -1) {
      out.push(pairIdBySlot.slice())
      return
    }

    used[firstUnused] = 1
    pairIdBySlot[firstUnused] = nextPairId
    for (let j = firstUnused + 1; j < slotCount; j += 1) {
      if (used[j] !== 0) continue
      used[j] = 1
      pairIdBySlot[j] = nextPairId
      recurse(nextPairId + 1)
      used[j] = 0
    }
    used[firstUnused] = 0
  }

  recurse(0)
  matchingCache.set(slotCount, out)
  return out
}

function fillZBySlot(
  zBySlot: Uint8Array,
  encoded: number,
  depth: number,
): void {
  let value = encoded
  for (let slot = 0; slot < zBySlot.length; slot += 1) {
    zBySlot[slot] = value % depth
    value = Math.floor(value / depth)
  }
}

function visitPermutations(
  values: number[],
  visit: (ordered: readonly number[]) => void,
): void {
  if (values.length <= 1) {
    visit(values)
    return
  }

  const recurse = (start: number): void => {
    if (start >= values.length) {
      visit(values)
      return
    }

    for (let i = start; i < values.length; i += 1) {
      const temp = values[start]!
      values[start] = values[i]!
      values[i] = temp
      recurse(start + 1)
      values[i] = values[start]!
      values[start] = temp
    }
  }

  recurse(0)
}

function buildGroups(partSizes: readonly number[]): number[][] {
  const out = new Array<number[]>(partSizes.length)
  let nextSlot = 0
  for (let groupIndex = 0; groupIndex < partSizes.length; groupIndex += 1) {
    const size = partSizes[groupIndex]!
    const group = new Array<number>(size)
    for (let i = 0; i < size; i += 1) {
      group[i] = nextSlot
      nextSlot += 1
    }
    out[groupIndex] = group
  }
  return out
}

function canonicalizeTopologySignature(
  groups: readonly number[][],
  pairIdBySlot: Uint8Array,
  zBySlot: Uint8Array,
  pairCount: number,
  depth: number,
): string {
  const groupCount = groups.length
  let best: string | null = null

  const pairOccurrences = new Array<number[]>(pairCount)
  for (let pair = 0; pair < pairCount; pair += 1) pairOccurrences[pair] = []

  const zOccurrences = new Array<number[]>(depth)
  for (let z = 0; z < depth; z += 1) zOccurrences[z] = []

  const pairOrder = new Array<number>(pairCount)
  const permutedPairOrder = new Array<number>(pairCount)
  const normPair = new Int32Array(pairCount)
  const usedZ = new Array<number>(depth)
  const normZ = new Int32Array(depth)

  for (let reverse = 0; reverse < 2; reverse += 1) {
    for (let shift = 0; shift < groupCount; shift += 1) {
      for (let pair = 0; pair < pairCount; pair += 1)
        pairOccurrences[pair]!.length = 0
      for (let z = 0; z < depth; z += 1) zOccurrences[z]!.length = 0

      for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
        const sourceIndex =
          reverse === 1
            ? (shift - groupIndex + groupCount) % groupCount
            : (shift + groupIndex) % groupCount
        const group = groups[sourceIndex]!
        for (let i = 0; i < group.length; i += 1) {
          const slot = group[i]!
          pairOccurrences[pairIdBySlot[slot]!]!.push(groupIndex)
          zOccurrences[zBySlot[slot]!]!.push(groupIndex)
        }
      }

      for (let pair = 0; pair < pairCount; pair += 1) pairOrder[pair] = pair
      pairOrder.sort((a, b) => {
        const cmp = compareNumberArrays(
          pairOccurrences[a]!,
          pairOccurrences[b]!,
        )
        return cmp !== 0 ? cmp : a - b
      })

      const pairBlocks: number[][] = []
      for (let start = 0; start < pairCount; ) {
        let end = start + 1
        while (
          end < pairCount &&
          compareNumberArrays(
            pairOccurrences[pairOrder[start]!]!,
            pairOccurrences[pairOrder[end]!]!,
          ) === 0
        ) {
          end += 1
        }
        pairBlocks.push(pairOrder.slice(start, end))
        start = end
      }

      let usedZCount = 0
      for (let z = 0; z < depth; z += 1) {
        if (zOccurrences[z]!.length > 0) {
          usedZ[usedZCount] = z
          usedZCount += 1
        }
      }
      const visitPairPermutations = (
        blockIndex: number,
        writeOffset: number,
      ): void => {
        if (blockIndex >= pairBlocks.length) {
          for (let rank = 0; rank < pairCount; rank += 1) {
            normPair[permutedPairOrder[rank]!] = rank
          }

          const usedZPermutation = usedZ.slice(0, usedZCount)
          visitPermutations(usedZPermutation, (orderedZ) => {
            for (let rank = 0; rank < orderedZ.length; rank += 1) {
              normZ[orderedZ[rank]!] = rank
            }

            const serializedGroups = new Array<string>(groupCount)
            for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
              const sourceIndex =
                reverse === 1
                  ? (shift - groupIndex + groupCount) % groupCount
                  : (shift + groupIndex) % groupCount
              const group = groups[sourceIndex]!
              const tokens = new Array<number>(group.length)
              for (let i = 0; i < group.length; i += 1) {
                const slot = group[i]!
                tokens[i] =
                  normPair[pairIdBySlot[slot]!] * depth + normZ[zBySlot[slot]!]!
              }
              tokens.sort((a, b) => a - b)
              const out = new Array<string>(tokens.length)
              for (let i = 0; i < tokens.length; i += 1) {
                out[i] =
                  `${Math.floor(tokens[i]! / depth)}:${tokens[i]! % depth}`
              }
              serializedGroups[groupIndex] = `[${out.join(",")}]`
            }

            const signature = serializedGroups.join("|")
            if (best === null || signature < best) best = signature
          })
          return
        }

        const block = pairBlocks[blockIndex]!
        if (block.length === 1) {
          permutedPairOrder[writeOffset] = block[0]!
          visitPairPermutations(blockIndex + 1, writeOffset + 1)
          return
        }

        const blockPermutation = block.slice()
        visitPermutations(blockPermutation, (orderedBlock) => {
          for (let i = 0; i < orderedBlock.length; i += 1) {
            permutedPairOrder[writeOffset + i] = orderedBlock[i]!
          }
          visitPairPermutations(
            blockIndex + 1,
            writeOffset + orderedBlock.length,
          )
        })
      }

      visitPairPermutations(0, 0)
    }
  }

  return best ?? ""
}

function getTopologyCounts(
  binsPerSide: number,
  depth: number,
  pairCount: number,
  collectDistinctQSignatures: boolean,
): TopologyCountResult {
  const maxBoundaryGroups = Math.min(pairCount * 2, binsPerSide * 4)
  const cacheKey = `${maxBoundaryGroups}:${depth}:${pairCount}`
  const cached = topologyCountCache.get(cacheKey)
  if (cached !== undefined && !collectDistinctQSignatures) return cached

  const slotCount = pairCount * 2
  const groupsByComposition = getCompositions(slotCount, maxBoundaryGroups).map(
    buildGroups,
  )
  const pairIdBySlotList = getPairIdBySlotList(slotCount)
  const zAssignmentCount = depth ** slotCount
  const zBySlot = new Uint8Array(slotCount)
  const allSignatures = new Set<string>()
  const distinctQSignatures = new Set<string>()

  for (
    let groupIndex = 0;
    groupIndex < groupsByComposition.length;
    groupIndex += 1
  ) {
    const groups = groupsByComposition[groupIndex]!
    const isDistinctQOnly = groups.length === slotCount

    for (
      let matchingIndex = 0;
      matchingIndex < pairIdBySlotList.length;
      matchingIndex += 1
    ) {
      const pairIdBySlot = pairIdBySlotList[matchingIndex]!

      for (let encodedZ = 0; encodedZ < zAssignmentCount; encodedZ += 1) {
        fillZBySlot(zBySlot, encodedZ, depth)
        const signature = canonicalizeTopologySignature(
          groups,
          pairIdBySlot,
          zBySlot,
          pairCount,
          depth,
        )
        allSignatures.add(signature)
        if (isDistinctQOnly) distinctQSignatures.add(signature)
      }
    }
  }

  const out: TopologyCountResult = {
    all: allSignatures.size,
    distinctQOnly: distinctQSignatures.size,
    distinctQSignatures: collectDistinctQSignatures
      ? [...distinctQSignatures].sort((a, b) => a.localeCompare(b))
      : undefined,
  }

  topologyCountCache.set(cacheKey, {
    all: out.all,
    distinctQOnly: out.distinctQOnly,
  })
  return out
}

function analyzeParameters(
  binsPerSide: number,
  depth: number,
  pairCount: number,
): ParameterRow {
  const profile = getSymmetryProfile(binsPerSide, depth)
  const topologyCounts = getTopologyCounts(binsPerSide, depth, pairCount, false)

  return {
    binsPerSide,
    depth,
    pairCount,
    currentBaseKeyClassesAll: countSymmetryReducedPairMultisets(
      profile,
      pairCount,
    ),
    topologyClassesAll: topologyCounts.all,
    topologyClassesDistinctQOnly: topologyCounts.distinctQOnly,
  }
}

function formatTable(rows: readonly ParameterRow[]): string {
  const columns = [
    {
      header: "binsPerSide",
      get: (row: ParameterRow) => String(row.binsPerSide),
    },
    {
      header: "depth",
      get: (row: ParameterRow) => String(row.depth),
    },
    {
      header: "pairCount",
      get: (row: ParameterRow) => String(row.pairCount),
    },
    {
      header: "currentBaseKeyClassesAll",
      get: (row: ParameterRow) => row.currentBaseKeyClassesAll.toString(),
    },
    {
      header: "topologyClassesAll",
      get: (row: ParameterRow) => String(row.topologyClassesAll),
    },
    {
      header: "topologyClassesDistinctQOnly",
      get: (row: ParameterRow) => String(row.topologyClassesDistinctQOnly),
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
  const rows: ParameterRow[] = []

  for (const binsPerSide of options.binsPerSide) {
    for (const depth of options.depths) {
      for (const pairCount of options.pairCounts) {
        rows.push(analyzeParameters(binsPerSide, depth, pairCount))
      }
    }
  }

  console.log(formatTable(rows))

  if (options.showClasses) {
    const binsPerSide = options.binsPerSide[0]!
    const depth = options.depths[0]!
    const pairCount = options.pairCounts[0]!
    const topologyCounts = getTopologyCounts(
      binsPerSide,
      depth,
      pairCount,
      true,
    )
    console.log("")
    console.log("Distinct-q topology signatures:")
    for (const signature of topologyCounts.distinctQSignatures ?? []) {
      console.log(`${pairCount}#${signature}`)
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
