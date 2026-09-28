/** Prepare one host generation; never continue a recall against a reloaded repository. */
export async function prepareGraphRecallInputs(options: {
  flushCaptures: () => Promise<void>
  flushV4: () => void
  syncL1: () => Promise<void>
  isCurrent: () => boolean
}): Promise<void> {
  const check = () => { if (!options.isCurrent()) throw new Error('Graph memory reloaded while preparing recall') }
  check()
  await options.flushCaptures()
  check()
  options.flushV4()
  check()
  await options.syncL1()
  check()
}
