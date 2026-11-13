// Every info drawing at once, for the layout check (check.ts) to find words
// that run into each other: each pop as the "i" opens it, laid in a grid.

import { infoTip, type InfoTopic } from "../src/views/infotip.ts";

const TOPICS: InfoTopic[] = ["heights", "feeder", "offset", "upcam", "references", "runout"];
const grid = document.getElementById("tips")!;
for (const topic of TOPICS) {
    const pop = infoTip(topic).querySelector(".info-tip-pop")!.cloneNode(true) as HTMLElement;
    pop.classList.add("tips-shown");
    pop.dataset["topic"] = topic;
    grid.append(pop);
}
document.body.dataset["ready"] = "1";
