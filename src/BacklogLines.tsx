import React, { memo } from "react";
import { boxGlyphs, renderStyled } from "./ansi";
import type { BacklogBlock, BacklogDocument, BacklogRow } from "./backlog";

const rowNodes = new WeakMap<BacklogRow, React.ReactElement>();
function rowNode(row: BacklogRow) {
  let node = rowNodes.get(row);
  if (!node) {
    node = <React.Fragment key={row.id}>{renderStyled(row.text, row.styled, [], 0, -1, boxGlyphs)}</React.Fragment>;
    rowNodes.set(row, node);
  }
  return node;
}
const Block = memo(function Block({ block }: { block: BacklogBlock }) {
  return <>{block.rows.map(rowNode)}</>;
});

// No wrapper per row/block: copied text, pre layout and cell sizes stay exact.
export default memo(function BacklogLines({ document }: { document: BacklogDocument }) {
  return <>{document.blocks.map(block => <Block key={block.id} block={block}/>)}</>;
});
