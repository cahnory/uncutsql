import type { CompactionPreview } from "../compact.ts";
import { style } from "../terminal.ts";
import { promptIO, withConversation } from "./conversation.ts";

export const confirmCompaction = ({ baselinePath, id, lockPath, removed }: CompactionPreview) =>
  withConversation("Compaction cancelled.", (ui) =>
    promptIO(async () => {
      for (const path of removed) {
        ui.output.write(`${style("red", "Delete")}  ${path}\n`);
      }
      ui.output.write(`${style("green", "Create")}  ${baselinePath}\n`);
      ui.output.write(`${style("cyan", "Update")}  ${lockPath}\n`);
      ui.output.write(
        `${style("yellow", "Warning")}: Existing databases below ${id} must upgrade first.\n`,
      );
      return ui.confirm(`Compact migrations 1–${id}?`, true);
    }),
  );
