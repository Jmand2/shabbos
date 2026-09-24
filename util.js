/* Shabbos Clock — the handful of things every other file needs.

   Loaded as ordinary scripts, in the order index.html lists them, sharing one
   script scope. Not ES modules: jsdom cannot load <script type="module"> at
   all, and both behavioural suites work by loading the real index.html and
   running the real app inside it. Splitting the file was worth doing; giving up
   that harness to get import statements was not. */

const $ = (id) => document.getElementById(id);
function readJSON(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
