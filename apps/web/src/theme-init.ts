import { applyTheme, storedTheme } from "./theme.js";

// Runs before the first render, so a viewer's stored pick is on the page before anything is drawn.
applyTheme(storedTheme());
