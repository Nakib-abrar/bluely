/**
 * Words that carry no retrieval signal in a knowledge query. Queries are built from what the
 * other person just said, so question words and conversational filler are included too.
 */
const ENGLISH = `
a about above after again against all also am an and any are as at be because been before being
below between both but by can could did do does doing done down during each else even ever every
few for from further get gets getting got had has have having he her here hers herself him
himself his how however i if in into is it its itself just let lets like ll may me might more
most much must my myself near no nor not now of off often on once only or other our ours
ourselves out over own per please quite rather re really said same say says she should
so some such than that thats the their theirs them themselves then there these they this those
through thus to too under until up upon us very ve via was we well were what whats when where
which while who whom whose why will with would yeah yes yet you your yours yourself yourselves
okay ok um uh hmm oh tell know think thing things want wanted going gonna wanna kind sort
don doesn didn isn aren wasn weren won wouldn shouldn couldn hasn haven hadn cant
`

/** Common Bangla particles, conjunctions and pronouns. */
const BANGLA = `
এবং ও আর কি কী না নি তো যে এই সেই ওই তা টা টি টো গুলো গুলি হয় হয়েছে হবে আছে ছিল করে করা
জন্য থেকে কিন্তু বা অথবা যদি তাহলে তবে আমি আমরা আমার আমাদের তুমি তোমার আপনি আপনার আপনারা
সে তিনি তারা তাদের এটা ওটা সেটা এখানে সেখানে কেন কেমন কোন কোনো কত কবে কোথায় একটু খুব
`

/** Lower-cased, NFC-normalized stopwords (Bangla included). */
export const STOPWORDS: ReadonlySet<string> = new Set(
  `${ENGLISH} ${BANGLA}`
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => w.normalize('NFC').toLowerCase()),
)
