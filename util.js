// WHICH BUILD THIS IS, written into the shell itself.
//
// The status panel could say which build was DEPLOYED (version.json, which the
// worker never caches) and which generation the cache held, and inferred the
// running one from the second. A cache name is where files came from, not what
// is executing — after an install the new generation exists while the page you
// are looking at is still the old one. This constant travels with the code, so
// the running JS can say what it is.
//
// NOT TYPED BY HAND: .github/workflows/stamp.yml rewrites the line below with
// the commit being deployed, the same way and at the same moment it rewrites
// the worker's VERSION.
const BUILD = 'dev';   // rewritten on deploy by .github/workflows/stamp.yml

/* Shabbos Clock — the handful of things every other file needs.

   Loaded as ordinary scripts, in the order index.html lists them, sharing one
   script scope. Not ES modules: jsdom cannot load <script type="module"> at
   all, and both behavioural suites work by loading the real index.html and
   running the real app inside it. Splitting the file was worth doing; giving up
   that harness to get import statements was not. */

const $ = (id) => document.getElementById(id);
function readJSON(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
