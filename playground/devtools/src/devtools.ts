// The devtools page: it adds the panel, and in Safari answers the panel's evals (bridge.ts).

import { ext, panelPage } from "./bridge.ts";

ext.devtools.panels.create("ermine", "icon-32.png", panelPage());
