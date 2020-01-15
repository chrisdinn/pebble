// TODO(peter):
//
// - interactions
//   - mouse wheel: horizontal zoom
//   - click/drag: horizontal pan

"use strict";

// The heights of each level. The first few levels are given smaller
// heights to account for the increasing target file size.
//
// TODO(peter): Use the TargetFileSizes specified in the OPTIONS file.
const levelHeights = [16, 16, 16, 16, 32, 64, 128];
const levelOffsets = levelHeights.map((v, i) =>
    levelHeights.slice(0, i + 1).reduce((sum, elem) => sum + elem, 24)
);
const lineStart = 105;
let levelWidth = 0;

{
    // Create the base DOM elements.
    let c = d3
        .select("body")
        .append("div")
        .attr("id", "container");
    let h = c.append("div").attr("id", "header");
    h
        .append("div")
        .attr("id", "index-container")
        .append("input")
        .attr("type", "text")
        .attr("id", "index")
        .attr("autocomplete", "off");
    h.append("svg").attr("id", "slider");
    c.append("svg").attr("id", "vis");
}

let vis = d3.select("#vis");
vis
    .append("text")
    .attr("class", "help")
    .attr("x", 10)
    .attr("y", levelOffsets[6] + 30)
    .text(
        "(space: start/stop, left-arrow[+shift]: step-back, right-arrow[+shift]: step-forward)"
    );

let reason = vis
    .append("text")
    .attr("class", "reason")
    .attr("x", 10)
    .attr("y", 16);

let index = d3.select("#index");

// Pretty formatting of a number in human readable units.
function humanize(s) {
    const iecSuffixes = [" B", " KB", " MB", " GB", " TB", " PB", " EB"];
    if (s < 10) {
        return "" + s;
    }
    let e = Math.floor(Math.log(s) / Math.log(1024));
    let suffix = iecSuffixes[Math.floor(e)];
    let val = Math.floor(s / Math.pow(1024, e) * 10 + 0.5) / 10;
    return val.toFixed(val < 10 ? 1 : 0) + suffix;
}

function styleWidth(e) {
    let width = +e.style("width").slice(0, -2);
    return Math.round(Number(width));
}

function styleHeight(e) {
    let height = +e.style("height").slice(0, -2);
    return Math.round(Number(height));
}

let sliderX, sliderHandle;

// The version object holds the current LSM state.
let version = {
    levels: [[], [], [], [], [], [], []],
    // The version edit index.
    index: -1,

    // Set the version edit index. This steps either forward or
    // backward through the version edits, applying or unapplying each
    // edit.
    set: function(index) {
        if (index < 0) {
            index = 0;
        } else if (index >= data.Edits.length) {
            index = data.Edits.length - 1;
        }
        if (index == this.index) {
            return;
        }

        // If the current edit index is less than the target index,
        // step forward applying edits.
        for (; this.index < index; this.index++) {
            let edit = data.Edits[this.index + 1];
            for (let level in edit.Deleted) {
                this.remove(level, edit.Deleted[level]);
            }
            for (let level in edit.Added) {
                this.add(level, edit.Added[level]);
            }
        }

        // If the current edit index is greater than the target index,
        // step backward unapplying edits.
        for (; this.index > index; this.index--) {
            let edit = data.Edits[this.index];
            for (let level in edit.Added) {
                this.remove(level, edit.Added[level]);
            }
            for (let level in edit.Deleted) {
                this.add(level, edit.Deleted[level]);
            }
        }

        // Sort the levels.
        for (let i in this.levels) {
            if (i == 0) {
                this.levels[i].sort(function(a, b) {
                    let fa = data.Files[a];
                    let fb = data.Files[b];
                    if (fa.LargestSeqNum < fb.LargestSeqNum) {
                        return -1;
                    }
                    if (fa.LargestSeqNum > fb.LargestSeqNum) {
                        return +1;
                    }
                    if (fa.SmallestSeqNum < fb.SmallestSeqNum) {
                        return -1;
                    }
                    if (fa.SmallestSeqNum > fb.SmallestSeqNum) {
                        return +1;
                    }
                    return a < b;
                });
            } else {
                this.levels[i].sort(function(a, b) {
                    let fa = data.Files[a];
                    let fb = data.Files[b];
                    if (fa.Smallest < fb.Smallest) {
                        return -1;
                    }
                    if (fa.Smallest > fb.Smallest) {
                        return +1;
                    }
                    return 0;
                });
            }
        }

        this.render();
    },

    // Add the specified sstables to the specifed level.
    add: function(level, fileNums) {
        for (let i = 0; i < fileNums.length; i++) {
            this.levels[level].push(fileNums[i]);
        }
    },

    // Remove the specified sstables from the specifed level.
    remove: function(level, fileNums) {
        let l = this.levels[level];
        for (let i = 0; i < l.length; i++) {
            if (fileNums.indexOf(l[i]) != -1) {
                l[i] = l[l.length - 1];
                l.pop();
                i--;
            }
        }
    },

    // Return the size of the sstables in a level.
    size: function(level) {
        return this.levels[level].reduce(
            (sum, elem) => sum + data.Files[elem].Size,
            0
        );
    },

    // Returns the height to use for an sstable.
    height: function(fileNum) {
        let meta = data.Files[fileNum];
        return Math.ceil((meta.Size + 1024.0 * 1024.0 - 1) / (1024.0 * 1024.0));
    },

    scale: function(level) {
        return levelWidth < this.levels[level].length
            ? levelWidth / this.levels[level].length
            : 1;
    },

    // Return a summary of the count and size of the specified sstables.
    summarize: function(level, fileNums) {
        let count = 0;
        let size = 0;
        for (let fileNum of fileNums) {
            count++;
            size += data.Files[fileNum].Size;
        }
        return count + " @ " + "L" + level + " (" + humanize(size) + ")";
    },

    // Return a textual description of a version edit.
    describe: function(edit) {
        let s = edit.Reason;

        if (edit.Deleted) {
            let sep = " ";
            for (let i = 0; i < 7; i++) {
                if (edit.Deleted[i]) {
                    s += sep + this.summarize(i, edit.Deleted[i]);
                    sep = " + ";
                }
            }
        }

        if (edit.Added) {
            let sep = " => ";
            for (let i = 0; i < 7; i++) {
                if (edit.Added[i]) {
                    s += sep + this.summarize(i, edit.Added[i]);
                    sep = " + ";
                }
            }
        }

        return s;
    },

    render: function() {
        let version = this;

        vis.interrupt();

        // Render the edit info.
        let info = "[" + this.describe(data.Edits[this.index]) + "]";
        reason.text(info);

        // Render the text for each level: sstable count and size.
        vis
            .selectAll("text.levels")
            .data(this.levels)
            .enter()
            .append("text")
            .attr("class", "levels")
            .attr("x", 10)
            .attr("y", (d, i) => levelOffsets[i])
            .text((d, i) => "L" + i);
        vis
            .selectAll("text.counts")
            .data(this.levels)
            .text((d, i) => d.length)
            .enter()
            .append("text")
            .attr("class", "counts")
            .attr("text-anchor", "end")
            .attr("x", 55)
            .attr("y", (d, i) => levelOffsets[i])
            .text((d, i) => d.length);
        vis
            .selectAll("text.sizes")
            .data(this.levels)
            .text((d, i) => humanize(version.size(i)))
            .enter()
            .append("text")
            .attr("class", "sizes")
            .attr("text-anchor", "end")
            .attr("x", 100)
            .attr("y", (d, i) => levelOffsets[i])
            .text((d, i) => humanize(version.size(i)));

        // Render each of the levels. Each level is composed of an
        // outer group which provides a clipping recentangle, an inner
        // group defining the coordinate system, an overlap rectangle
        // to capture mouse events, an indicator rectangle used to
        // display sstable overlaps, and the per-sstable rectangles.
        for (let i in this.levels) {
            let g = vis
                .selectAll("g.clip" + i)
                .select("g")
                .data([i]);
            let clipG = g
                .enter()
                .append("g")
                .attr("class", "clip" + i)
                .attr("clip-path", "url(#L" + i + ")");
            clipG
                .append("g")
                .attr(
                    "transform",
                    "translate(" +
                        lineStart +
                        "," +
                        levelOffsets[i] +
                        ") scale(1,-1)"
                );
            clipG.append("rect").attr("class", "indicator");

            // Define the overlap rectangle for capturing mouse events.
            clipG
                .append("rect")
                .attr("x", lineStart)
                .attr("y", levelOffsets[i] - levelHeights[i])
                .attr("width", levelWidth)
                .attr("height", levelHeights[i])
                .attr("opacity", 0)
                .attr("pointer-events", "all")
                .on("mousemove", i => version.onMouseMove(i))
                .on("mouseout", function() {
                    reason.text(info);
                    vis.selectAll("rect.indicator").attr("fill", "none");
                });

            // Scale each level to fit within the display.
            let s = this.scale(i);
            g.attr(
                "transform",
                "translate(" +
                    lineStart +
                    "," +
                    levelOffsets[i] +
                    ") scale(" +
                    s +
                    "," +
                    -(1 / s) +
                    ")"
            );

            // Render the sstables for the level.
            let level = g.selectAll("rect.L" + i).data(this.levels[i], d => d);
            level.attr("fill", "#555").attr("x", (fileNum, i) => i);
            level
                .enter()
                .append("rect")
                .attr("class", "L" + i)
                .attr("id", fileNum => fileNum)
                .attr("fill", "red")
                .attr("x", (fileNum, i) => i)
                .attr("y", 0)
                .attr("width", 1)
                .attr("height", fileNum => version.height(fileNum));
            level.exit().remove();
        }

        sliderHandle.attr("cx", sliderX(version.index));
        index.node().value = version.index;
    },

    onMouseMove: function(i) {
        i = Number(i);
        if (this.levels[i].length == 0) {
            return;
        }

        // The mouse coordinates are relative to the
        // SVG element. Adjust to be relative to the
        // level position.
        let mousex = d3.mouse(vis.node())[0] - lineStart;
        let index = Math.round(mousex / this.scale(i));
        if (index < 0) {
            index = 0;
        } else if (index >= this.levels[i].length) {
            index = this.levels[i].length - 1;
        }
        let fileNum = this.levels[i][index];
        let meta = data.Files[fileNum];

        // Find the start and end index of the tables
        // that overlap with filenum.
        let overlapInfo = "";
        for (let j = 1; j < this.levels.length; j++) {
            if (this.levels[j].length == 0) {
                continue;
            }
            let indicator = vis.select("g.clip" + j + " rect.indicator");
            indicator
                .attr("fill", "black")
                .attr("opacity", 0.3)
                .attr("y", levelOffsets[j] - levelHeights[j])
                .attr("height", levelHeights[j]);
            if (j == i) {
                continue;
            }
            let fileNums = this.levels[j];
            for (let k in fileNums) {
                let other = data.Files[fileNums[k]];
                if (other.Largest < meta.Smallest) {
                    continue;
                }
                let s = this.scale(j);
                let t = k;
                for (; k < fileNums.length; k++) {
                    let other = data.Files[fileNums[k]];
                    if (other.Smallest >= meta.Largest) {
                        break;
                    }
                }
                if (k == t) {
                    indicator.attr("x", lineStart + s * t).attr("width", s);
                } else {
                    indicator
                        .attr("x", lineStart + s * t)
                        .attr("width", Math.max(0.5, s * (k - t)));
                }
                if (i + 1 == j && k > t) {
                    let overlapSize = this.levels[j]
                        .slice(t, k)
                        .reduce((sum, elem) => sum + data.Files[elem].Size, 0);

                    overlapInfo =
                        " overlaps " +
                        (k - t) +
                        " @ L" +
                        j +
                        " (" +
                        humanize(overlapSize) +
                        ")";
                }
                break;
            }
        }

        // TODO(peter): display smallest/largest key.
        reason.text(
            "[L" +
                i +
                " " +
                fileNum +
                " (" +
                humanize(data.Files[fileNum].Size) +
                ")" +
                overlapInfo +
                "]"
        );

        vis
            .select("g.clip" + i + " rect.indicator")
            .attr("x", lineStart + this.scale(i) * index)
            .attr("width", 1);
    }
};

// Recalculate structures related to the page width.
function updateSize() {
    let svg = d3.select("#slider").html("");

    let margin = { right: 10, left: 10 };

    let width = styleWidth(d3.select("#slider")) - margin.left - margin.right,
        height = styleHeight(svg);

    sliderX = d3
        .scaleLinear()
        .domain([0, data.Edits.length - 1])
        .range([0, width])
        .clamp(true);

    let slider = svg
        .append("g")
        .attr("class", "slider")
        .attr("transform", "translate(" + margin.left + "," + height / 2 + ")");

    slider
        .append("line")
        .attr("class", "track")
        .attr("x1", sliderX.range()[0])
        .attr("x2", sliderX.range()[1])
        .select(function() {
            return this.parentNode.appendChild(this.cloneNode(true));
        })
        .attr("class", "track-inset")
        .select(function() {
            return this.parentNode.appendChild(this.cloneNode(true));
        })
        .attr("class", "track-overlay")
        .call(
            d3
                .drag()
                .on("start.interrupt", function() {
                    slider.interrupt();
                })
                .on("start drag", function() {
                    version.set(Math.round(sliderX.invert(d3.event.x)));
                })
        );

    slider
        .insert("g", ".track-overlay")
        .attr("class", "ticks")
        .attr("transform", "translate(0," + 18 + ")")
        .selectAll("text")
        .data(sliderX.ticks(10))
        .enter()
        .append("text")
        .attr("x", sliderX)
        .attr("text-anchor", "middle")
        .text(function(d) {
            return d;
        });

    sliderHandle = slider
        .insert("circle", ".track-overlay")
        .attr("class", "handle")
        .attr("r", 9)
        .attr("cx", sliderX(version.index));

    levelWidth = styleWidth(vis) - 10 - lineStart;
    let lineEnd = lineStart + levelWidth;

    vis
        .selectAll("line")
        .data(levelOffsets)
        .attr("x2", lineEnd)
        .enter()
        .append("line")
        .attr("x1", lineStart)
        .attr("x2", lineEnd)
        .attr("y1", d => d)
        .attr("y2", d => d)
        .attr("stroke", "#ddd");

    vis
        .selectAll("defs clipPath rect")
        .data(version.levels)
        .attr("width", lineEnd - lineStart)
        .enter()
        .append("defs")
        .append("clipPath")
        .attr("id", (d, i) => "L" + i)
        .append("rect")
        .attr("x", lineStart)
        .attr("y", (d, i) => levelOffsets[i] - levelHeights[i])
        .attr("width", lineEnd - lineStart)
        .attr("height", (d, i) => levelHeights[i]);
}

window.onload = function() {
    updateSize();
    version.set(0);
};

window.addEventListener("resize", function() {
    updateSize();
    version.render();
});

let timer;

function startPlayback(increment) {
    timer = d3.timer(function() {
        let lastIndex = version.index;
        version.set(version.index + increment);
        if (lastIndex == version.index) {
            timer.stop();
            timer = null;
        }
    });
}

function stopPlayback() {
    if (timer == null) {
        return false;
    }
    timer.stop();
    timer = null;
    return true;
}

document.addEventListener("keydown", function(e) {
    switch (e.keyCode) {
        case 37: // left arrow
            stopPlayback();
            version.set(version.index - (e.shiftKey ? 10 : 1));
            return;
        case 39: // right arrow
            stopPlayback();
            version.set(version.index + (e.shiftKey ? 10 : 1));
            return;
        case 32: // space
            if (stopPlayback()) {
                return;
            }
            startPlayback(1);
            return;
    }
});

index.on("input", function() {
    if (!isNaN(+this.value)) {
        version.set(Number(this.value));
    }
});
