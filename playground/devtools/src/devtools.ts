// The devtools page: it only adds the panel.

import { ext } from "./bridge.ts";

ext.devtools.panels.create("ermine", "icon-32.png", "panel.html");
