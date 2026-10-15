// Fixture test bodies sleep for a fixed time, scaled by FIXTURE_SCALE.
export const pause = (ms: number) => new Promise((r) => setTimeout(r, ms * Number(process.env.FIXTURE_SCALE ?? 1)));
