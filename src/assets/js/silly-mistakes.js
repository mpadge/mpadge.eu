// Progressively-revealed decision chart, drawn with d3. A note includes
//   <div id="decision-chart"></div>
//   <script defer src="/assets/js/silly-mistakes.js"></script>
// The chart starts with only the root node; clicking a node reveals (or hides)
// its children. Edit TREE below to extend the chart.
import { select } from 'd3-selection';
import { hierarchy, tree } from 'd3-hierarchy';
import { linkVertical } from 'd3-shape';

const SMALL_W = 90; // width of the narrow boxes (set per node with `w:`)

const TREE = {
    text: 'What did it effect?',
    children: [
        {
            text: 'Only me',
            children: [
                { text: 'Learn from it, and then go forth' }
            ]
        },
        {
            text: 'Money',
            children: [
                {
                    text: 'Can you survive without it?',
                    children: [
                        {
                            text: 'Yes',
                            children: [
                                { text: 'All is good; go forth' }
                            ]
                        },
                        {
                            text: 'No',
                            children: [
                                {
                                    text: 'Can you earn more money?',
                                    children: [
                                        {
                                            text: 'Yes',
                                            children: [
                                                { text: 'All will be good; go forth'}
                                            ]
                                        },
                                        {
                                            text: 'No',
                                            children: [
                                                { text: "Shit, that's not good. Seek external help.", kind: 'bad' }
                                            ]
                                        }
                                    ]
                                }
                            ]
                        }
                    ]
                }
            ]
        },
        {
            text: 'Other people',
            children: [
                {
                    text: 'Did you apologise?',
                    children: [
                        {
                            text: "Yes",
                            children: [
                                { text: "First make sure they're really okay and then go forth"}
                            ]
                        },
                        { 
                            text: "No",
                            children: [
                                { text: "Seriously not? Go and apologise right now", kind: 'bad' }
                            ]
                        }
                    ]
                }
            ]
        }
    ]
};


// ---- Layout constants --------------------------------------------------------
// Wide layout (a top-down tree) is used when the container is at least as wide
// as the fully expanded tree; otherwise a compact, indented list is used, so the
// text never has to shrink and nothing scrolls sideways.
const BOX_W = 190, GAP_X = 24, GAP_Y = 50, PAD = 4;
const CHAR_PX = 8.5;   // approximate glyph width, used to wrap labels to a box width
const LINE_PX = 20;    // line height of wrapped labels
const INDENT = 14;     // compact layout: indent per level
const GAP_C = 12;      // compact layout: vertical gap between rows
const RESET_W_C = 76;  // compact layout: width of the Reset button
const MAX_C = 380;     // compact layout: maximum width of the list

// Colours for coloured nodes. Text colours are explicit (not currentColor) so the
// labels stay readable on the fill in both light and dark page themes.
const KINDS = {
    end: { fill: '#c8ecb9', stroke: '#5f9f4a', ink: '#1d3a12' }, // light green
    bad: { fill: '#c2570c', stroke: '#7a3606', ink: '#ffffff' }  // dark orange
};
// A node's `kind: 'end' | 'bad'` picks its colours; nodes without children
// default to 'end'; everything else is uncoloured.
const kindOf = d => KINDS[d.data.kind || (d.data.children ? '' : 'end')];

const boxW = d => d.data.w || BOX_W;
const RESET_X = BOX_W + GAP_X; // wide layout: x of the Reset button (root is at x = 0)

// Greedy word-wrap of a label to fit a box of the given pixel width.
function wrap(text, width) {
    const max = Math.max(6, Math.floor((width - 10) / CHAR_PX));
    const lines = [];
    text.split(' ').forEach(word => {
        const last = lines[lines.length - 1];
        if (last !== undefined && (last + ' ' + word).length <= max) lines[lines.length - 1] = last + ' ' + word;
        else lines.push(word);
    });
    return lines;
}

// A unique key per node (labels such as "Yes" / "No" repeat, so they can't be keys).
const keyOf = d => d.ancestors().map(a => a.data.text).reverse().join('>');

const container = document.getElementById('decision-chart');
if (container) {
    const root = hierarchy(TREE);
    const everyNode = root.descendants(); // all nodes, whether currently shown or not

    // Collapse every node. Iterate over a pre-collected array: d3's each() reads
    // node.children *after* the callback, so nulling them mid-walk skips subtrees.
    const collapse = node => node.descendants().forEach(d => {
        if (d.children) { d._children = d.children; d.children = null; }
    });
    // Initial (and Reset) state: everything collapsed except the root, so the
    // second row is already showing.
    const resetState = () => {
        collapse(root);
        if (root._children) { root.children = root._children; root._children = null; }
    };

    // Wide layout: x spacing comes from the separation function, so boxes can
    // differ in width.
    const separation = (a, b) => (boxW(a) + boxW(b)) / 2 + GAP_X * (a.parent === b.parent ? 1 : 2);

    // Horizontal extent of the wide layout is measured once on the fully expanded
    // tree and then kept fixed, so the chart never shifts sideways as nodes open.
    tree().nodeSize([1, 100]).separation(separation)(root);
    const X0 = Math.min(...everyNode.map(d => d.x - boxW(d) / 2)) - PAD;
    const X1 = Math.max(RESET_X + BOX_W / 2, ...everyNode.map(d => d.x + boxW(d) / 2)) + PAD;
    const WIDE_W = X1 - X0;

    resetState();
    const link = linkVertical().x(d => d.x).y(d => d.y);

    const svg = select(container).append('svg')
        .attr('role', 'group')
        .style('display', 'block').style('margin', '2rem auto')
        .style('max-width', 'none')
        .style('font', 'inherit').style('color', 'inherit');
    const links = svg.append('g').attr('fill', 'none')
        .attr('stroke', 'currentColor').attr('stroke-opacity', .6).attr('stroke-width', 2);
    const nodes = svg.append('g');

    const toggle = (event, d) => {
        if (!d.data.children) return; // leaf: nothing to toggle
        // Opening a node closes its siblings (and their subtrees), so only the
        // current branch stays open.
        if (d._children && d.parent) d.parent.children.forEach(sib => { if (sib !== d) collapse(sib); });
        [d.children, d._children] = [d._children, d.children];
        update();
    };

    // "Reset" button: collapse back to the starting state.
    const reset = svg.append('g')
        .style('cursor', 'pointer')
        .on('click', () => {
            resetState();
            update();
        });
    const resetRect = reset.append('rect').attr('rx', 8).attr('fill', 'none')
        .attr('stroke', 'currentColor').attr('stroke-width', 2)
        .attr('stroke-dasharray', '6 4')
        .style('pointer-events', 'all');
    reset.append('text').attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'central').attr('fill', 'currentColor').text('Reset');

    function update() {
        const cw = container.clientWidth;
        const compact = cw > 0 && cw < WIDE_W;
        const all = root.descendants();

        // Box width at each depth in the compact layout (root shares its row with Reset).
        const rightC = Math.min(cw - 1, MAX_C);
        const leftC = depth => 1 + depth * INDENT;
        const widthC = depth => depth === 0 ? rightC - 1 - RESET_W_C - GAP_C : rightC - leftC(depth);

        const heightFor = (text, width) => Math.max(40, wrap(text, width).length * LINE_PX + 16);

        let vb, resetW, resetX, resetH;
        if (compact) {
            // Indented list: each box is as tall as its own (wrapped) label needs.
            let y = 0;
            root.eachBefore(d => {
                d.gw = widthC(d.depth);
                d.gx = leftC(d.depth) + d.gw / 2;
                d.gh = heightFor(d.data.text, d.gw);
                d.gy = y;
                y += d.gh + GAP_C;
            });
            vb = [0, -PAD, rightC + 1, y - GAP_C + 2 * PAD];
            resetW = RESET_W_C; resetX = rightC - RESET_W_C / 2; resetH = root.gh;
        } else {
            // Tree: one uniform box height, sized for the tallest label in the whole
            // tree, so boxes don't change height as branches open and close.
            const bh = Math.max(...everyNode.map(n => heightFor(n.data.text, boxW(n))), 58);
            tree().nodeSize([1, bh + GAP_Y]).separation(separation)(root);
            all.forEach(d => { d.gx = d.x; d.gy = d.y; d.gw = boxW(d); d.gh = bh; });
            vb = [X0, -PAD, WIDE_W, Math.max(...all.map(d => d.gy)) + bh + 2 * PAD];
            resetW = BOX_W; resetX = RESET_X; resetH = bh;
        }
        svg.attr('viewBox', vb).attr('width', vb[2]).attr('height', vb[3])
            .style('margin', compact ? '2rem 0' : '2rem auto'); // list: left-aligned; tree: centred

        reset.attr('transform', `translate(${resetX},0)`);
        resetRect.attr('x', -resetW / 2).attr('width', resetW).attr('height', resetH);
        reset.select('text').attr('y', resetH / 2);

        links.selectAll('path').data(root.links(), d => keyOf(d.target))
            .join('path')
            .attr('d', d => {
                const s = d.source, t = d.target;
                if (!compact) return link({ source: { x: s.gx, y: s.gy + s.gh }, target: { x: t.gx, y: t.gy } });
                // Elbow: down from near the parent's left edge, then right into the child.
                const sx = s.gx - s.gw / 2 + 6, tx = t.gx - t.gw / 2;
                return `M${sx},${s.gy + s.gh} V${t.gy + t.gh / 2} H${tx}`;
            });

        const g = nodes.selectAll('g').data(all, keyOf)
            .join(enter => {
                const g = enter.append('g');
                g.append('rect').attr('rx', 8)
                    .attr('stroke', d => kindOf(d) ? kindOf(d).stroke : 'currentColor')
                    .attr('stroke-width', 2)
                    .style('pointer-events', 'all'); // clickable even when fill is 'none'
                g.append('text')
                    .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
                    .attr('fill', d => kindOf(d) ? kindOf(d).ink : 'currentColor');
                return g;
            })
            .attr('transform', d => `translate(${d.gx},${d.gy})`)
            .style('cursor', d => (d._children || d.children) && d.data.children ? 'pointer' : 'default')
            .on('click', toggle);
        g.select('rect')
            .attr('x', d => -d.gw / 2).attr('width', d => d.gw).attr('height', d => d.gh)
            .attr('fill', d => kindOf(d) ? kindOf(d).fill : d._children ? 'rgba(127,127,127,.15)' : 'none');
        g.select('text').attr('y', d => d.gh / 2)
            .each(function (d) {
                const lines = wrap(d.data.text, d.gw);
                select(this).selectAll('tspan').data(lines).join('tspan')
                    .attr('x', 0)
                    .attr('dy', (l, i) => i ? '1.2em' : `${-0.6 * (lines.length - 1)}em`)
                    .text(l => l);
            });
    }

    window.addEventListener('resize', update);
    update();
}
