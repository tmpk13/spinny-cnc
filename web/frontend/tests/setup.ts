// Registers a DOM for every test file so views can mount.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof document === "undefined") {
    GlobalRegistrator.register({ url: "http://localhost/" });
}
