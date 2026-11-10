/**
 * The whitelist page: one self-contained HTML file. Its script builds every row
 * with textContent, so a note can never be read as markup. The script avoids
 * template literals because the page itself is one.
 */
export const ADMIN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Jar whitelist</title>
<style>
  :root {
    --bg: #f6f7f5; --card: #ffffff; --text: #1c211d; --muted: #667069; --line: #e1e5e0;
    --accent: #1f7a4d; --accent-text: #ffffff; --danger: #b3261e; --ok-bg: #e6f4ec; --err-bg: #fdecea;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #121513; --card: #1b1f1c; --text: #e8ece8; --muted: #98a39b; --line: #2c322d;
      --accent: #4cc38a; --accent-text: #0c1a12; --danger: #ff8a80; --ok-bg: #173324; --err-bg: #3a1c1a;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  p.lead { margin: 0 0 24px; color: var(--muted); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin-bottom: 16px; }
  h2 { font-size: 15px; margin: 0 0 12px; }
  form.add { display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: end; }
  label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 4px; }
  input { width: 100%; padding: 10px 12px; font: inherit; color: var(--text); background: var(--bg);
    border: 1px solid var(--line); border-radius: 8px; }
  input:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  button { font: inherit; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--line);
    background: var(--card); color: var(--text); cursor: pointer; white-space: nowrap; }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); font-weight: 600; }
  button.danger { color: var(--danger); }
  button:disabled { opacity: .5; cursor: default; }
  .hint { font-size: 13px; color: var(--muted); margin: 8px 0 0; }
  #status { display: none; padding: 10px 12px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }
  #status.ok { display: block; background: var(--ok-bg); }
  #status.err { display: block; background: var(--err-bg); color: var(--danger); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: grid; grid-template-columns: 1fr auto; gap: 8px 12px; align-items: center;
    padding: 12px 0; border-top: 1px solid var(--line); }
  li:first-child { border-top: 0; padding-top: 0; }
  li:last-child { padding-bottom: 0; }
  .phone { font-variant-numeric: tabular-nums; font-weight: 600; overflow-wrap: anywhere; }
  .meta { font-size: 13px; color: var(--muted); overflow-wrap: anywhere; }
  .actions { display: flex; gap: 8px; }
  .edit { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .empty { color: var(--muted); margin: 0; }
  .count { font-weight: 400; color: var(--muted); }
  @media (max-width: 560px) {
    form.add, .edit { grid-template-columns: 1fr; }
    li { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<main>
  <h1>Jar whitelist</h1>
  <p class="lead">Jar replies on WhatsApp only to the numbers in this list. A change takes effect on the next message.</p>

  <div id="status" role="status" aria-live="polite"></div>

  <section class="card">
    <h2>Add a number</h2>
    <form class="add" id="add">
      <div>
        <label for="phone">Phone number, with country code</label>
        <input id="phone" name="phone" inputmode="tel" autocomplete="off" placeholder="910000000000" required>
      </div>
      <div>
        <label for="note">Name or note (optional)</label>
        <input id="note" name="note" autocomplete="off" maxlength="100" placeholder="Test user">
      </div>
      <button class="primary" type="submit">Add</button>
    </form>
    <p class="hint">For an Indian number, put 91 in front of the 10 digits.</p>
  </section>

  <section class="card">
    <h2>Whitelisted numbers <span class="count" id="count"></span></h2>
    <ul id="list"></ul>
    <p class="empty" id="empty" hidden>No numbers yet, so Jar is not replying to anyone.</p>
  </section>
</main>

<script>
(function () {
  var base = location.pathname.replace(/\\/+$/, "") + "/api/numbers";
  var list = document.getElementById("list");
  var statusBox = document.getElementById("status");
  var editing = null;
  var entries = [];

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function say(kind, text) {
    statusBox.className = kind;
    statusBox.textContent = text;
  }
  function call(method, path, body) {
    return fetch(base + path, {
      method: method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined
    }).then(function (response) {
      if (response.status === 204) return null;
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");
        return data;
      });
    }, function () {
      throw new Error("Could not reach the server. Check your connection and try again.");
    });
  }
  function button(text, className, onClick) {
    var node = el("button", className, text);
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
  }
  function field(labelText, value, max) {
    var wrap = el("div");
    var input = el("input");
    input.value = value;
    input.setAttribute("aria-label", labelText);
    input.autocomplete = "off";
    if (max) input.maxLength = max;
    wrap.appendChild(input);
    return { wrap: wrap, input: input };
  }

  function viewRow(entry) {
    var row = el("li");
    var info = el("div");
    info.appendChild(el("div", "phone", "+" + entry.phone));
    var added = new Date(entry.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    info.appendChild(el("div", "meta", (entry.note ? entry.note + " · " : "") + "added " + added));
    var actions = el("div", "actions");
    actions.appendChild(button("Edit", "", function () { editing = entry.phone; render(); }));
    actions.appendChild(button("Delete", "danger", function () {
      if (!confirm("Remove +" + entry.phone + "? Jar will stop replying to this number.")) return;
      call("DELETE", "/" + entry.phone).then(function () {
        say("ok", "Removed +" + entry.phone + ".");
        return load();
      }).catch(function (error) { say("err", error.message); load(); });
    }));
    row.appendChild(info);
    row.appendChild(actions);
    return row;
  }
  function editRow(entry) {
    var row = el("li");
    var fields = el("div", "edit");
    var phone = field("Phone number, with country code", entry.phone);
    phone.input.inputMode = "tel";
    var note = field("Name or note", entry.note || "", 100);
    fields.appendChild(phone.wrap);
    fields.appendChild(note.wrap);
    var actions = el("div", "actions");
    function save() {
      call("PUT", "/" + entry.phone, { phone: phone.input.value, note: note.input.value }).then(function (saved) {
        editing = null;
        say("ok", "Saved +" + saved.phone + ".");
        return load();
      }).catch(function (error) { say("err", error.message); });
    }
    actions.appendChild(button("Save", "primary", save));
    actions.appendChild(button("Cancel", "", function () { editing = null; render(); }));
    [phone.input, note.input].forEach(function (input) {
      input.addEventListener("keydown", function (event) {
        if (event.key === "Enter") save();
        if (event.key === "Escape") { editing = null; render(); }
      });
    });
    row.appendChild(fields);
    row.appendChild(actions);
    setTimeout(function () { phone.input.focus(); }, 0);
    return row;
  }
  function render() {
    list.replaceChildren.apply(list, entries.map(function (entry) {
      return entry.phone === editing ? editRow(entry) : viewRow(entry);
    }));
    document.getElementById("empty").hidden = entries.length > 0;
    document.getElementById("count").textContent = entries.length ? "(" + entries.length + ")" : "";
  }
  function load() {
    return call("GET", "").then(function (data) {
      entries = data;
      render();
    }).catch(function (error) { say("err", error.message); });
  }

  document.getElementById("add").addEventListener("submit", function (event) {
    event.preventDefault();
    var form = event.target;
    var submit = form.querySelector("button");
    submit.disabled = true;
    call("POST", "", { phone: form.phone.value, note: form.note.value }).then(function (saved) {
      form.reset();
      say("ok", "Added +" + saved.phone + ". Jar now replies to this number.");
      return load();
    }).catch(function (error) { say("err", error.message); }).then(function () { submit.disabled = false; });
  });

  load();
})();
</script>
</body>
</html>
`;
