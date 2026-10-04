// The optype the conformance suite uses: core/docs/protocol.tex, "The optype basic".
//
// Values are any JSON. { set: v } replaces the whole value and applies to an
// empty node too; { splice: [from, to, s] } edits a string by code points.
// Anything else is not an op. It is here and not in the core because the core
// has no optypes of its own; a graph is given its optypes when made.

const std = @import("std");
const ermine = @import("ermine.zig");
const json = @import("json.zig");
const Value = json.Value;
const Error = ermine.Error;

pub const optype = ermine.Optype{ .holds = holds, .apply = apply };

fn holds(_: *const Value) bool {
    return true;
}

fn notAnOp(graph: *ermine.Graph, op: *const Value) Error {
    return graph.refusal.setQuoting("not an op: {s}", op);
}

/// a JSON number that is a whole number, as splice's positions must be
fn wholeNumber(value: *const Value) ?i64 {
    const x = switch (value.*) {
        .number => |n| n,
        else => return null,
    };
    if (!std.math.isFinite(x) or x != @floor(x) or @abs(x) >= 9007199254740992.0) return null;
    return @intFromFloat(x);
}

/// the byte offset at which code point `index` of `text` begins, or null when the text is shorter
fn byteOffsetOfCodePoint(text: []const u8, index: usize) ?usize {
    var iterator = std.unicode.Utf8View.initUnchecked(text).iterator();
    var seen: usize = 0;
    while (seen < index) : (seen += 1) {
        _ = iterator.nextCodepointSlice() orelse return null;
    }
    return iterator.i;
}

/// the ops applied in order to the value (or to emptiness); the result is the caller's
fn apply(graph: *ermine.Graph, held: ?*const Value, ops: []const Value) Error!Value {
    const allocator = graph.allocator;
    var current: ?Value = if (held) |value| try value.clone(allocator) else null;
    errdefer if (current) |*value| value.deinit(allocator);
    for (ops) |*op| {
        const members = op.asObject() orelse return notAnOp(graph, op);
        if (members.count() != 1) return notAnOp(graph, op);
        if (members.getPtr("set")) |value| {
            const next = try value.clone(allocator);
            if (current) |*old| old.deinit(allocator);
            current = next;
            continue;
        }
        const splice = members.getPtr("splice") orelse return notAnOp(graph, op);
        const parts = splice.asArray() orelse return notAnOp(graph, op);
        if (parts.len != 3) return notAnOp(graph, op);
        const from = wholeNumber(&parts[0]) orelse return notAnOp(graph, op);
        const to = wholeNumber(&parts[1]) orelse return notAnOp(graph, op);
        const insert = parts[2].asString() orelse return notAnOp(graph, op);
        const text = if (current) |*value| value.asString() else null;
        if (text == null) {
            if (current) |*value| {
                const shown = try json.stringify(allocator, value);
                defer allocator.free(shown);
                return graph.refuse("splice applies only to a string, not {s}", .{shown});
            }
            return graph.refuse("splice applies only to a string, not an empty node", .{});
        }
        const points = std.unicode.utf8CountCodepoints(text.?) catch unreachable;
        if (from < 0 or to < from or to > points) return graph.refuse("splice [{d}, {d}) is outside a string of {d} code points", .{ from, to, points });
        const start = byteOffsetOfCodePoint(text.?, @intCast(from)).?;
        const end = byteOffsetOfCodePoint(text.?, @intCast(to)).?;
        const spliced = try std.mem.concat(allocator, u8, &.{ text.?[0..start], insert, text.?[end..] });
        if (current) |*old| old.deinit(allocator);
        current = .{ .string = spliced };
    }
    return current orelse graph.refuse("the ops leave no value", .{});
}
