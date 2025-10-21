// Initialise Supabase and global state
const { createClient } = supabase;

// Replace with your Supabase project URL and anon/public key
const supabaseUrl = 'https://xwmndpgfhjafczipoktv.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh3bW5kcGdmaGphZmN6aXBva3R2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjA1Mjc5MzUsImV4cCI6MjA3NjEwMzkzNX0.3MbwVrb2QrHkEuk5Vm_ziPdkKVc99Wk2vMQpdxLYQ6U';
const supabaseClient = createClient(supabaseUrl, supabaseKey);

// Application state
let currentPerformance = null;
let currentTickets = [];
let channelChart = null;
let distChart = null;
let editingIndex = -1; // index of ticket being edited; -1 means adding new

/** Helpers */
function todayYMD() {
  const d = new Date();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// Log a change into daily_changes table if value changed
async function logDailyChange(field_name, old_value, new_value) {
  if (!currentPerformance || old_value === new_value) return;
  const change_amount = (new_value || 0) - (old_value || 0);
  await supabaseClient.from('daily_changes').insert({
    performance_id: currentPerformance.id,
    change_date: todayYMD(),
    field_name,
    old_value: old_value || 0,
    new_value: new_value || 0,
    change_amount
  });
}

/** Populate year select */
function populateYears() {
  const yearSel = document.getElementById('yearSelect');
  const currentYear = new Date().getFullYear();
  // Populate 5 years before to 5 years after current year
  for (let y = currentYear - 5; y <= currentYear + 5; y++) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y;
    if (y === currentYear) opt.selected = true;
    yearSel.appendChild(opt);
  }
}

/** Load or create performance row for selected year/month */
async function loadMonth() {
  const year = parseInt(document.getElementById('yearSelect').value);
  // Month stored in DB as 1–12. We use 1-based value from the select.
  const monthVal = parseInt(document.getElementById('monthSelect').value); // 1–12
  // Fetch performance row for this year and month
  const { data: rows } = await supabaseClient
    .from('performance_data')
    .select('*')
    .eq('year', year)
    .eq('month', monthVal);
  let row = null;
  if (rows && rows.length > 0) {
    // Choose row with largest total interactions (in case duplicates)
    row = rows.reduce((best, cur) => {
      const bestTotal = (best.good || 0) + (best.bad || 0) + (best.karma_bad || 0);
      const curTotal = (cur.good || 0) + (cur.bad || 0) + (cur.karma_bad || 0);
      return curTotal > bestTotal ? cur : best;
    }, rows[0]);
  }
  if (!row) {
    // Create a new record with zero counts, including Genesys fields. Store month as 1–12.
    const { data: inserted } = await supabaseClient
      .from('performance_data')
      .insert({
        year,
        month: monthVal,
        good: 0,
        bad: 0,
        karma_bad: 0,
        good_phone: 0,
        good_chat: 0,
        good_email: 0,
        genesys_good: 0,
        genesys_bad: 0
      })
      .select()
      .single();
    row = inserted;
  }
  currentPerformance = row;
  editingIndex = -1;
  resetTicketForm();
  await loadTickets();
  updateUI();
  await refreshDailyLog();
}

/** Load tickets for current performance row */
async function loadTickets() {
  if (!currentPerformance) {
    currentTickets = [];
    return;
  }
  // Attempt to load tickets by performance_id first
  let { data: tickets, error: tErr } = await supabaseClient
    .from('tickets')
    .select('*')
    .eq('performance_id', currentPerformance.id)
    .order('created_at', { ascending: true });
  if (tErr) {
    console.error('Error loading tickets by performance_id', tErr);
  }
  // If no tickets found, fall back to fetching tickets within the month by created_at date range
  if (!tickets || tickets.length === 0) {
    try {
      const year = currentPerformance.year;
      const monthVal = currentPerformance.month; // 1–12
      const monthIdx = monthVal - 1;
      const startDate = new Date(year, monthIdx, 1);
      const endDate = new Date(year, monthIdx + 1, 1);
      const fromIso = startDate.toISOString();
      const toIso = endDate.toISOString();
      const res = await supabaseClient
        .from('tickets')
        .select('*')
        .gte('created_at', fromIso)
        .lt('created_at', toIso)
        .order('created_at', { ascending: true });
      if (!res.error) {
        tickets = res.data;
      }
    } catch (e) {
      console.error('Fallback ticket query failed', e);
    }
  }
  // Normalize ticket type: unify case and convert legacy values
  currentTickets = (tickets || []).map((t) => {
    const rawType = (t.type || '').trim().toUpperCase();
    let norm;
    if (rawType === 'CSAT' || rawType === 'DSAT' || rawType === 'BAD') {
      norm = 'DSAT';
    } else {
      // Treat any other negative type as Karma
      norm = 'Karma';
    }
    return { ...t, type: norm };
  });
}

/** Update numeric field with delta and log */
async function updateValue(field, delta) {
  if (!currentPerformance) return;
  let newVal = (currentPerformance[field] || 0) + delta;
  if (newVal < 0) newVal = 0;
  const oldVal = currentPerformance[field] || 0;
  const { data } = await supabaseClient
    .from('performance_data')
    .update({ [field]: newVal })
    .eq('id', currentPerformance.id)
    .select()
    .single();
  currentPerformance = data;
  await logDailyChange(field, oldVal, newVal);
  updateUI();
  await refreshDailyLog();
}

/** Update good counts by channel */
async function updateGoodCounts() {
  if (!currentPerformance) return;
  const phone = parseInt(document.getElementById('phoneGood').value) || 0;
  const chat = parseInt(document.getElementById('chatGood').value) || 0;
  const email = parseInt(document.getElementById('emailGood').value) || 0;
  // Capture old values before update for logging
  const oldPhone = currentPerformance.good_phone || 0;
  const oldChat = currentPerformance.good_chat || 0;
  const oldEmail = currentPerformance.good_email || 0;
  const { data } = await supabaseClient
    .from('performance_data')
    .update({ good_phone: phone, good_chat: chat, good_email: email })
    .eq('id', currentPerformance.id)
    .select()
    .single();
  currentPerformance = data;
  // Log daily changes for good channel counts
  await logDailyChange('good_phone', oldPhone, phone);
  await logDailyChange('good_chat', oldChat, chat);
  await logDailyChange('good_email', oldEmail, email);
  updateUI();
  await refreshDailyLog();
}

/** Update Genesys counts and log */
async function updateGenesysCounts() {
  if (!currentPerformance) return;
  const gGood = parseInt(document.getElementById('genesysGood').value) || 0;
  const gBad = parseInt(document.getElementById('genesysBad').value) || 0;
  const oldGood = currentPerformance.genesys_good || 0;
  const oldBad = currentPerformance.genesys_bad || 0;
  const { data } = await supabaseClient
    .from('performance_data')
    .update({ genesys_good: gGood, genesys_bad: gBad })
    .eq('id', currentPerformance.id)
    .select()
    .single();
  currentPerformance = data;
  await logDailyChange('genesys_good', oldGood, gGood);
  await logDailyChange('genesys_bad', oldBad, gBad);
  updateUI();
  await refreshDailyLog();
}

/** Add new ticket (DSAT/Karma) and adjust counts + log */
async function addNewTicket(ticketId, type, channel, note) {
  // Insert into tickets table
  const { data: newTicket, error: insErr } = await supabaseClient
    .from('tickets')
    .insert({
      performance_id: currentPerformance.id,
      ticket_id: ticketId,
      type,
      channel,
      note: note || null
    })
    .select()
    .single();
  if (insErr) {
    console.error('Error inserting ticket', insErr);
    return;
  }
  // Adjust counts based on type
  const field = type === 'DSAT' ? 'bad' : 'karma_bad';
  const oldVal = currentPerformance[field] || 0;
  const newCount = oldVal + 1;
  const { data: updatedRow } = await supabaseClient
    .from('performance_data')
    .update({ [field]: newCount })
    .eq('id', currentPerformance.id)
    .select()
    .single();
  currentPerformance = updatedRow;
  await logDailyChange(field, oldVal, newCount);
}

/** Edit existing ticket and adjust counts if type changes + log */
async function updateExistingTicket(index, ticketId, type, channel, note) {
  const original = currentTickets[index];
  if (!original) return;
  // If type changed, update counts
  if (original.type !== type) {
    const decField = original.type === 'DSAT' ? 'bad' : 'karma_bad';
    const incField = type === 'DSAT' ? 'bad' : 'karma_bad';
    const oldDec = currentPerformance[decField] || 0;
    const oldInc = currentPerformance[incField] || 0;
    const decVal = Math.max(0, oldDec - 1);
    const incVal = oldInc + 1;
    const { data: updRow } = await supabaseClient
      .from('performance_data')
      .update({ [decField]: decVal, [incField]: incVal })
      .eq('id', currentPerformance.id)
      .select()
      .single();
    currentPerformance = updRow;
    await logDailyChange(decField, oldDec, decVal);
    await logDailyChange(incField, oldInc, incVal);
  }
  await supabaseClient
    .from('tickets')
    .update({ ticket_id: ticketId, type, channel, note: note || null })
    .eq('id', original.id)
    .select()
    .single();
}

/** Submit ticket form: add new or update existing */
async function submitTicket() {
  if (!currentPerformance) return;
  const ticketId = document.getElementById('ticketLink').value.trim();
  const type = document.getElementById('ticketType').value; // DSAT|Karma
  const channel = document.getElementById('ticketChannel').value;
  const note = document.getElementById('ticketNote').value.trim();
  if (!ticketId) {
    alert('Please enter a ticket ID or link.');
    return;
  }
  if (editingIndex === -1) {
    await addNewTicket(ticketId, type, channel, note);
  } else {
    await updateExistingTicket(editingIndex, ticketId, type, channel, note);
  }
  resetTicketForm();
  editingIndex = -1;
  await loadTickets();
  updateUI();
  await refreshDailyLog();
}

/** Reset ticket form and button states */
function resetTicketForm() {
  document.getElementById('ticketLink').value = '';
  document.getElementById('ticketNote').value = '';
  document.getElementById('ticketType').value = 'DSAT';
  document.getElementById('ticketChannel').value = 'Phone';
  document.getElementById('addTicketBtn').textContent = 'Add Ticket';
  document.getElementById('cancelEditBtn').style.display = 'none';
}

/** Cancel editing mode */
function cancelEdit() {
  editingIndex = -1;
  resetTicketForm();
}

/** Populate form for editing a ticket */
function editTicket(index) {
  const t = currentTickets[index];
  if (!t) return;
  editingIndex = index;
  document.getElementById('ticketLink').value = t.ticket_id;
  document.getElementById('ticketNote').value = t.note || '';
  document.getElementById('ticketType').value = t.type; // DSAT|Karma
  document.getElementById('ticketChannel').value = t.channel;
  document.getElementById('addTicketBtn').textContent = 'Save Ticket';
  document.getElementById('cancelEditBtn').style.display = 'inline-block';
}

/** Delete ticket at index and adjust counts + log */
async function removeTicket(index) {
  const t = currentTickets[index];
  if (!t) return;
  const { error } = await supabaseClient.from('tickets').delete().eq('id', t.id);
  if (error) {
    console.error('Error deleting ticket', error);
    return;
  }
  // Update counts
  const field = t.type === 'DSAT' ? 'bad' : 'karma_bad';
  const oldVal = currentPerformance[field] || 0;
  const newVal = Math.max(0, oldVal - 1);
  const { data: updatedRow } = await supabaseClient
    .from('performance_data')
    .update({ [field]: newVal })
    .eq('id', currentPerformance.id)
    .select()
    .single();
  currentPerformance = updatedRow;
  await logDailyChange(field, oldVal, newVal);
  await loadTickets();
  editingIndex = -1;
  resetTicketForm();
  updateUI();
  await refreshDailyLog();
}

/** Compute metrics with Genesys included */
function computeMetrics() {
  if (!currentPerformance) {
    return {
      csat: 0,
      karma: 0,
      needCsat: { 88: 0, 90: 0, 95: 0 },
      needKarma: { 88: 0, 90: 0, 95: 0 }
    };
  }
  const g0 = currentPerformance.good || 0;
  const b0 = currentPerformance.bad || 0;
  const k = currentPerformance.karma_bad || 0;
  const gg = currentPerformance.genesys_good || 0;
  const gb = currentPerformance.genesys_bad || 0;
  const g = g0 + gg;
  const b = b0 + gb;
  const denomCsat = g + b;
  const csat = denomCsat > 0 ? (g / denomCsat) * 100 : 0;
  const denomKarma = g + b + k;
  const karmaP = denomKarma > 0 ? (g / denomKarma) * 100 : 0;
  function calcNeeded(th, includeKarma) {
    const t = th;
    const extraDen = includeKarma ? (b + k) : b;
    // Solve for x such that (g+x)/(g+x+extraDen) >= t
    const x = Math.ceil((t * (g + extraDen) - g) / (1 - t));
    return x > 0 ? x : 0;
  }
  const targets = [0.88, 0.90, 0.95];
  const needCsat = {};
  const needKarma = {};
  targets.forEach((thr) => {
    const per = Math.round(thr * 100);
    needCsat[per] = calcNeeded(thr, false);
    needKarma[per] = calcNeeded(thr, true);
  });
  return { csat, karma: karmaP, needCsat, needKarma };
}

/** Update metrics card content */
function updateMetrics() {
  const card = document.getElementById('metricsCard');
  if (!currentPerformance) {
    card.innerHTML = '';
    return;
  }
  const metrics = computeMetrics();
  let html = '<h2>Performance Metrics</h2>';
  html += `<p><strong>CSAT:</strong> ${metrics.csat.toFixed(1)}% &nbsp; <strong>Karma:</strong> ${metrics.karma.toFixed(1)}%</p>`;
  html += '<p style="margin-top:0.5rem;"><strong>Good ratings needed to reach targets:</strong></p>';
  for (const per in metrics.needCsat) {
    html += `<p>${per}% CSAT: ${metrics.needCsat[per]} &nbsp; | &nbsp; ${per}% Karma: ${metrics.needKarma[per]}</p>`;
  }
  html += `<div class="progress-bar"><span class="csat" style="width:${metrics.csat}%"></span></div>`;
  html += `<div class="progress-bar"><span class="karma" style="width:${metrics.karma}%"></span></div>`;
  card.innerHTML = html;
}

/** Weekly progress (simple cumulative snapshot) */
async function updateWeeklyProgress() {
  const container = document.getElementById('weeklyProgress');
  container.innerHTML = '';
  if (!currentPerformance) return;
  const targets = { 1: 80, 2: 84, 3: 86, 4: 88 };
  // Determine year and month (month stored as 1–12)
  const year = currentPerformance.year;
  const monthVal = currentPerformance.month; // 1–12
  // Convert to 0-based index for JavaScript Date
  const monthIdx = monthVal - 1;
  // Determine total days in this month
  const daysInMonth = new Date(year, monthVal, 0).getDate();
  // Define week end dates: Week1 ends on day 7, Week2 on 14, Week3 on 22, Week4 on end of month
  const weekEnds = [
    new Date(year, monthIdx, 7),
    new Date(year, monthIdx, 14),
    new Date(year, monthIdx, 22),
    new Date(year, monthIdx, daysInMonth)
  ];
  // Fetch all daily changes for this performance
  const { data: changes } = await supabaseClient
    .from('daily_changes')
    .select('*')
    .eq('performance_id', currentPerformance.id);
  // Fields that affect performance
  const fields = [
    'good_phone',
    'good_chat',
    'good_email',
    'genesys_good',
    'bad',
    'karma_bad',
    'genesys_bad'
  ];
  // Compute baseline counts (start-of-month values) by subtracting sum of logged changes from current values
  const baseline = {};
  fields.forEach((f) => {
    let sum = 0;
    (changes || []).forEach((c) => {
      if (c.field_name === f) {
        sum += c.change_amount;
      }
    });
    baseline[f] = (currentPerformance[f] || 0) - sum;
  });
  // Current date for determining completed vs in-progress weeks
  const today = new Date();
  // Generate weekly cards
  for (let i = 0; i < 4; i++) {
    const endDate = weekEnds[i];
    // Determine start date: for first week it's day 1; otherwise previous end date + 1
    let startDate;
    if (i === 0) {
      startDate = new Date(year, monthIdx, 1);
    } else {
      // add one day to previous week end
      startDate = new Date(weekEnds[i - 1].getTime());
      startDate.setDate(startDate.getDate() + 1);
    }
    // Aggregate baseline values
    const agg = {};
    fields.forEach((f) => {
      agg[f] = baseline[f];
    });
    // Sum changes up to the end date
    (changes || []).forEach((c) => {
      const cd = new Date(c.change_date + 'T00:00:00');
      if (cd <= endDate) {
        if (fields.includes(c.field_name)) {
          agg[c.field_name] += c.change_amount;
        }
      }
    });
    // Compute good/bad/karma counts for this week
    const goodCount =
      (agg.good_phone || 0) + (agg.good_chat || 0) + (agg.good_email || 0) + (agg.genesys_good || 0);
    const badCount = (agg.bad || 0) + (agg.genesys_bad || 0);
    const karmaCount = agg.karma_bad || 0;
    const csat = goodCount + badCount > 0 ? (goodCount / (goodCount + badCount)) * 100 : 0;
    const karma = goodCount + badCount + karmaCount > 0 ? (goodCount / (goodCount + badCount + karmaCount)) * 100 : 0;
    const weekNumber = i + 1;
    // Determine status: completed or in-progress
    let statusText;
    let cardClass;
    if (endDate < today) {
      const met = csat >= targets[weekNumber];
      statusText = `${met ? '✓ Met' : '✗ Below'} target (${targets[weekNumber]}%)`;
      cardClass = met ? 'good' : 'bad';
    } else if (endDate.getDate() === today.getDate() && endDate.getMonth() === today.getMonth() && endDate.getFullYear() === today.getFullYear()) {
      // If today equals end date, consider week completed
      const met = csat >= targets[weekNumber];
      statusText = `${met ? '✓ Met' : '✗ Below'} target (${targets[weekNumber]}%)`;
      cardClass = met ? 'good' : 'bad';
    } else {
      statusText = `⚠ In progress (target ${targets[weekNumber]}%)`;
      cardClass = 'in-progress';
    }
    // Format range display (e.g., 1–7)
    const rangeText = `${startDate.getDate()} – ${endDate.getDate()}`;
    const card = document.createElement('div');
    card.className = `week-card ${cardClass}`;
    card.innerHTML = `
      <div class="row"><strong>Week ${weekNumber}</strong> <span class="range">(${rangeText})</span></div>
      <div class="row">CSAT: <strong>${csat.toFixed(1)}%</strong> &nbsp; Karma: <strong>${karma.toFixed(1)}%</strong></div>
      <div class="status">${statusText}</div>
    `;
    container.appendChild(card);
  }
}

/** Pretty label mapping for daily change log */
function prettyFieldLabel(field) {
  if (field === 'bad') return 'DSAT';
  if (field === 'karma_bad') return 'Karma Bad';
  if (field === 'genesys_bad') return 'Genesys DSAT';
  if (field === 'genesys_good') return 'Genesys Good';
  if (field === 'good_phone') return 'Good Phone';
  if (field === 'good_chat') return 'Good Chat';
  if (field === 'good_email') return 'Good Email';
  return 'Good';
}

/** Refresh and render daily change log */
async function refreshDailyLog() {
  const list = document.getElementById('dailyLogList');
  if (!currentPerformance) {
    list.innerHTML = '';
    return;
  }
  // Always fetch all changes for the current performance (no date filters)
  const { data: changes } = await supabaseClient
    .from('daily_changes')
    .select('*')
    .eq('performance_id', currentPerformance.id)
    .order('change_date', { ascending: false })
    .order('created_at', { ascending: false });
  // Group by date
  const groups = {};
  (changes || []).forEach((c) => {
    (groups[c.change_date] ||= []).push(c);
  });
  list.innerHTML = '';
  Object.keys(groups)
    .sort((a, b) => (a < b ? 1 : -1))
    .forEach((date) => {
      const box = document.createElement('div');
      box.className = 'entry';
      const title = document.createElement('div');
      title.className = 'date';
      const nice = new Date(date + 'T00:00:00').toLocaleDateString(undefined, {
        month: 'long',
        day: 'numeric'
      });
      title.textContent = nice;
      box.appendChild(title);
      const row = document.createElement('div');
      groups[date].forEach((c, idx) => {
        const sign = c.change_amount >= 0 ? '+' : '';
        const badge = document.createElement('span');
        badge.className =
          'badge ' +
          (c.field_name.includes('karma')
            ? 'karma'
            : c.field_name.includes('bad')
            ? 'bad'
            : 'good');
        badge.textContent = `${sign}${c.change_amount} ${prettyFieldLabel(c.field_name)}`;
        if (idx > 0) row.appendChild(document.createTextNode(' '));
        row.appendChild(badge);
      });
      box.appendChild(row);
      list.appendChild(box);
    });
}

/** Update distribution charts (Good / DSAT only) */
function updateDistribution() {
  // Destroy existing distribution chart if present
  if (distChart) {
    distChart.destroy();
    distChart = null;
  }
  if (!currentPerformance) {
    return;
  }
  // Good counts per channel including Genesys contributions
  const goodCounts = {
    Phone: (currentPerformance.good_phone || 0) + (currentPerformance.genesys_good || 0),
    Chat: currentPerformance.good_chat || 0,
    Email: currentPerformance.good_email || 0
  };
  // DSAT counts per channel (tickets of type DSAT) including Genesys DSAT for Phone
  const dsatCounts = { Phone: 0, Chat: 0, Email: 0 };
  currentTickets.forEach((t) => {
    if (t.type === 'DSAT') dsatCounts[t.channel] = (dsatCounts[t.channel] || 0) + 1;
  });
  dsatCounts.Phone += currentPerformance.genesys_bad || 0;
  // Prepare data arrays for bar chart
  const channels = ['Phone', 'Chat', 'Email'];
  const goodData = channels.map((ch) => goodCounts[ch] || 0);
  const badData = channels.map((ch) => dsatCounts[ch] || 0);
  const ctx = document.getElementById('distChart').getContext('2d');
  distChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: channels,
      datasets: [
        {
          label: 'Good',
          data: goodData,
          backgroundColor: 'rgba(16,185,129,0.7)',
          borderColor: 'rgba(16,185,129,1)',
          borderWidth: 1
        },
        {
          label: 'DSAT',
          data: badData,
          backgroundColor: 'rgba(239,68,68,0.7)',
          borderColor: 'rgba(239,68,68,1)',
          borderWidth: 1
        }
      ]
    },
    options: {
      responsive: true,
      indexAxis: 'y',
      scales: {
        x: {
          beginAtZero: true,
          title: { display: true, text: 'Count' }
        }
      },
      plugins: { legend: { position: 'bottom' } }
    }
  });
}

/** Update channel analytics and bar chart (Good, DSAT, Karma) */
function updateChannelAnalytics() {
  const container = document.getElementById('channelAnalyticsContent');
  if (!currentPerformance) {
    container.innerHTML = '';
    if (channelChart) {
      channelChart.destroy();
      channelChart = null;
    }
    return;
  }
  const goodCounts = {
    Phone: (currentPerformance.good_phone || 0) + (currentPerformance.genesys_good || 0),
    Chat: currentPerformance.good_chat || 0,
    Email: currentPerformance.good_email || 0
  };
  const dsatCounts = { Phone: 0, Chat: 0, Email: 0 };
  const karmaCounts = { Phone: 0, Chat: 0, Email: 0 };
  currentTickets.forEach((t) => {
    if (t.type === 'DSAT') dsatCounts[t.channel] = (dsatCounts[t.channel] || 0) + 1;
    else karmaCounts[t.channel] = (karmaCounts[t.channel] || 0) + 1;
  });
  dsatCounts.Phone += currentPerformance.genesys_bad || 0;
  const channels = ['Phone', 'Chat', 'Email'];
  container.innerHTML = '';
  channels.forEach((ch) => {
    const g = goodCounts[ch] || 0;
    const d = dsatCounts[ch] || 0;
    const k = karmaCounts[ch] || 0;
    const total = g + d + k;
    const goodP = total > 0 ? (g / total) * 100 : 0;
    const dsatP = total > 0 ? (d / total) * 100 : 0;
    const karmaP = total > 0 ? (k / total) * 100 : 0;
    const card = document.createElement('div');
    card.className = 'channel-box';
    card.innerHTML = `
      <h3>${ch}</h3>
      <p><strong>Good:</strong> ${g}</p>
      <p><strong>DSAT Bad:</strong> ${d}</p>
      <p><strong>Karma Bad:</strong> ${k}</p>
      <p><strong>CSAT:</strong> ${g + d > 0 ? ((g / (g + d)) * 100).toFixed(1) : '0'}% &nbsp;
         <strong>Karma:</strong> ${total > 0 ? ((g / total) * 100).toFixed(1) : '0'}%</p>
      <div class="progress">
        <span class="good" style="width:${goodP}%"></span>
        <span class="csat" style="width:${dsatP}%"></span>
        <span class="karma" style="width:${karmaP}%"></span>
      </div>
    `;
    container.appendChild(card);
  });
  // Bar chart for counts
  const barData = {
    labels: channels,
    datasets: [
      {
        label: 'Good',
        data: [goodCounts.Phone, goodCounts.Chat, goodCounts.Email],
        backgroundColor: 'rgba(16,185,129,0.7)',
        borderColor: 'rgba(16,185,129,1)',
        borderWidth: 1
      },
      {
        label: 'DSAT Bad',
        data: [dsatCounts.Phone, dsatCounts.Chat, dsatCounts.Email],
        backgroundColor: 'rgba(239,68,68,0.7)',
        borderColor: 'rgba(239,68,68,1)',
        borderWidth: 1
      },
      {
        label: 'Karma Bad',
        data: [karmaCounts.Phone, karmaCounts.Chat, karmaCounts.Email],
        backgroundColor: 'rgba(168,85,247,0.7)',
        borderColor: 'rgba(168,85,247,1)',
        borderWidth: 1
      }
    ]
  };
  const ctx = document.getElementById('channelChart').getContext('2d');
  if (channelChart) channelChart.destroy();
  channelChart = new Chart(ctx, {
    type: 'bar',
    data: barData,
    options: {
      responsive: true,
      scales: {
        y: {
          beginAtZero: true,
          title: { display: true, text: 'Count' }
        }
      },
      plugins: { legend: { position: 'bottom' } }
    }
  });
}

/** Update tickets table */
function updateTicketsTable() {
  const tbody = document.getElementById('ticketsTable').querySelector('tbody');
  tbody.innerHTML = '';
  currentTickets.forEach((t, idx) => {
    const tr = document.createElement('tr');
    const tdIndex = document.createElement('td');
    tdIndex.textContent = idx + 1;
    const tdLink = document.createElement('td');
    if (/^https?:\/\//i.test(t.ticket_id)) {
      const a = document.createElement('a');
      a.href = t.ticket_id;
      a.target = '_blank';
      a.style.color = 'var(--primary)';
      a.style.textDecoration = 'underline';
      a.textContent = t.ticket_id;
      tdLink.appendChild(a);
    } else {
      tdLink.textContent = t.ticket_id;
    }
    const tdType = document.createElement('td');
    tdType.textContent = t.type;
    const tdChannel = document.createElement('td');
    tdChannel.textContent = t.channel;
    const tdNote = document.createElement('td');
    tdNote.textContent = t.note || '';
    const tdEdit = document.createElement('td');
    const btnEdit = document.createElement('button');
    btnEdit.className = 'btn-edit';
    btnEdit.textContent = 'Edit';
    btnEdit.onclick = function () {
      editTicket(idx);
    };
    tdEdit.appendChild(btnEdit);
    const tdDel = document.createElement('td');
    const btnDel = document.createElement('button');
    btnDel.className = 'btn-delete';
    btnDel.textContent = 'Remove';
    btnDel.onclick = function () {
      removeTicket(idx);
    };
    tdDel.appendChild(btnDel);
    tr.appendChild(tdIndex);
    tr.appendChild(tdLink);
    tr.appendChild(tdType);
    tr.appendChild(tdChannel);
    tr.appendChild(tdNote);
    tr.appendChild(tdEdit);
    tr.appendChild(tdDel);
    tbody.appendChild(tr);
  });
}

/** Update entire UI */
function updateUI() {
  if (!currentPerformance) {
    // Clear all elements when no performance
    document.getElementById('goodValue').textContent = '0';
    document.getElementById('badValue').textContent = '0';
    document.getElementById('karmaValue').textContent = '0';
    document.getElementById('phoneGood').value = '0';
    document.getElementById('chatGood').value = '0';
    document.getElementById('emailGood').value = '0';
    document.getElementById('genesysGood').value = '0';
    document.getElementById('genesysBad').value = '0';
    document.getElementById('phoneCombinedGood').textContent = '0';
    document.getElementById('phoneCombinedBad').textContent = '0';
    document.getElementById('metricsCard').innerHTML = '';
    document.getElementById('channelAnalyticsContent').innerHTML = '';
    document.getElementById('ticketsTable').querySelector('tbody').innerHTML = '';
    document.getElementById('weeklyProgress').innerHTML = '';
    document.getElementById('dailyLogList').innerHTML = '';
    if (channelChart) {
      channelChart.destroy();
      channelChart = null;
    }
    if (distChartGood) {
      distChartGood.destroy();
      distChartGood = null;
    }
    if (distChartBad) {
      distChartBad.destroy();
      distChartBad = null;
    }
    return;
  }
  // Top stats
  document.getElementById('goodValue').textContent = currentPerformance.good || 0;
  document.getElementById('badValue').textContent = currentPerformance.bad || 0;
  document.getElementById('karmaValue').textContent = currentPerformance.karma_bad || 0;
  // Channel good inputs
  document.getElementById('phoneGood').value = currentPerformance.good_phone || 0;
  document.getElementById('chatGood').value = currentPerformance.good_chat || 0;
  document.getElementById('emailGood').value = currentPerformance.good_email || 0;
  // Genesys inputs
  document.getElementById('genesysGood').value = currentPerformance.genesys_good || 0;
  document.getElementById('genesysBad').value = currentPerformance.genesys_bad || 0;
  // Combined phone totals
  const phoneCombinedG = (currentPerformance.good_phone || 0) + (currentPerformance.genesys_good || 0);
  const phoneCombinedB = (currentPerformance.bad || 0) + (currentPerformance.genesys_bad || 0);
  document.getElementById('phoneCombinedGood').textContent = phoneCombinedG;
  document.getElementById('phoneCombinedBad').textContent = phoneCombinedB;
  updateTicketsTable();
  updateMetrics();
  updateWeeklyProgress();
  updateDistribution();
  updateChannelAnalytics();
}

/** Init */
function init() {
  populateYears();
  const currentMonth = new Date().getMonth() + 1;
  document.getElementById('monthSelect').value = currentMonth.toString();
  document.getElementById('loadBtn').addEventListener('click', loadMonth);
  // Hide cancel button initially
  document.getElementById('cancelEditBtn').style.display = 'none';
  loadMonth();
}
document.addEventListener('DOMContentLoaded', init);