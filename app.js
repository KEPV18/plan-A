// Initialise Supabase and global state
// Import the createClient method from the global supabase object loaded via CDN
const { createClient } = supabase;

// Supabase credentials – using the user‑provided project URL and anon key
const supabaseUrl = 'https://xwmndpgfhjafczipoktv.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh3bW5kcGdmaGphZmN6aXBva3R2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjA1Mjc5MzUsImV4cCI6MjA3NjEwMzkzNX0.3MbwVrb2QrHkEuk5Vm_ziPdkKVc99Wk2vMQpdxLYQ6U';
const supabaseClient = createClient(supabaseUrl, supabaseKey);

// Global variables to hold the current performance row and tickets
let currentPerformance = null;
let currentTickets = [];
let channelChart = null;

/**
 * Populate the year selector with a range of years around the current year.
 */
function populateYears() {
  const yearSelect = document.getElementById('yearSelect');
  const currentYear = new Date().getFullYear();
  for (let y = currentYear - 5; y <= currentYear + 5; y++) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y;
    if (y === currentYear) opt.selected = true;
    yearSelect.appendChild(opt);
  }
}

/**
 * Load the performance data for the selected month and year from Supabase.
 * If no row exists yet, a new row is created with zero values.
 */
async function loadMonth() {
  const year = parseInt(document.getElementById('yearSelect').value);
  // Convert monthSelect value (1–12) to zero‑based index for storage
  const monthIndex = parseInt(document.getElementById('monthSelect').value) - 1;
  // Fetch all rows for the chosen month/year
  const { data: rows, error: fetchErr } = await supabaseClient
    .from('performance_data')
    .select('*')
    .eq('year', year)
    .eq('month', monthIndex);
  let row = null;
  if (!fetchErr && Array.isArray(rows) && rows.length > 0) {
    // Choose the row with the highest total (good + bad + karma_bad)
    row = rows.reduce((best, curr) => {
      const bestTotal = (best.good || 0) + (best.bad || 0) + (best.karma_bad || 0);
      const currTotal = (curr.good || 0) + (curr.bad || 0) + (curr.karma_bad || 0);
      return currTotal > bestTotal ? curr : best;
    }, rows[0]);
  }
  if (!row) {
    // No existing row – create a new entry
    const { data: inserted, error: insertErr } = await supabaseClient
      .from('performance_data')
      .insert({
        year: year,
        month: monthIndex,
        good: 0,
        bad: 0,
        karma_bad: 0,
        good_phone: 0,
        good_chat: 0,
        good_email: 0
      })
      .select()
      .single();
    if (insertErr) {
      console.error('Error creating performance row', insertErr);
      return;
    }
    row = inserted;
  }
  currentPerformance = row;
  // Load associated tickets
  await loadTickets();
  updateUI();
}

/**
 * Load all tickets linked to the current performance row.
 */
async function loadTickets() {
  if (!currentPerformance) {
    currentTickets = [];
    return;
  }
  const { data: tickets, error } = await supabaseClient
    .from('tickets')
    .select('*')
    .eq('performance_id', currentPerformance.id)
    .order('created_at', { ascending: true });
  if (error) {
    console.error('Error loading tickets', error);
    currentTickets = [];
  } else {
    currentTickets = tickets || [];
  }
}

/**
 * Increment or decrement a numeric field (good, bad, karma_bad) on the current row.
 * The value never goes below zero.
 */
async function updateValue(field, delta) {
  if (!currentPerformance) return;
  let newVal = (currentPerformance[field] || 0) + delta;
  if (newVal < 0) newVal = 0;
  const { data, error } = await supabaseClient
    .from('performance_data')
    .update({ [field]: newVal })
    .eq('id', currentPerformance.id)
    .select()
    .single();
  if (error) {
    console.error('Error updating', field, error);
    return;
  }
  currentPerformance = data;
  updateUI();
}

/**
 * Update good counts by channel (phone, chat, email).
 */
async function updateGoodCounts() {
  if (!currentPerformance) return;
  const phone = parseInt(document.getElementById('phoneGood').value) || 0;
  const chat = parseInt(document.getElementById('chatGood').value) || 0;
  const email = parseInt(document.getElementById('emailGood').value) || 0;
  const { data, error } = await supabaseClient
    .from('performance_data')
    .update({ good_phone: phone, good_chat: chat, good_email: email })
    .eq('id', currentPerformance.id)
    .select()
    .single();
  if (error) {
    console.error('Error updating good counts', error);
    return;
  }
  currentPerformance = data;
  updateUI();
}

/**
 * Add a new negative ticket to Supabase and adjust counts accordingly.
 */
async function addTicket() {
  if (!currentPerformance) return;
  const ticketId = document.getElementById('ticketLink').value.trim();
  const type = document.getElementById('ticketType').value;
  const channel = document.getElementById('ticketChannel').value;
  const note = document.getElementById('ticketNote').value.trim();
  if (!ticketId) {
    alert('Please enter a ticket ID or link.');
    return;
  }
  const { data: newTicket, error } = await supabaseClient
    .from('tickets')
    .insert({
      performance_id: currentPerformance.id,
      ticket_id: ticketId,
      type: type,
      channel: channel,
      note: note || null
    })
    .select()
    .single();
  if (error) {
    console.error('Error inserting ticket', error);
    return;
  }
  // Adjust counts on the performance row depending on ticket type
  const updateFields = {};
  if (type === 'CSAT') {
    updateFields.bad = (currentPerformance.bad || 0) + 1;
  } else {
    updateFields.karma_bad = (currentPerformance.karma_bad || 0) + 1;
  }
  const { data: updatedRow, error: updateErr } = await supabaseClient
    .from('performance_data')
    .update(updateFields)
    .eq('id', currentPerformance.id)
    .select()
    .single();
  if (!updateErr) {
    currentPerformance = updatedRow;
  }
  // Clear input fields
  document.getElementById('ticketLink').value = '';
  document.getElementById('ticketNote').value = '';
  await loadTickets();
  updateUI();
}

/**
 * Remove a ticket at the given index and update counts accordingly.
 */
async function removeTicket(index) {
  if (!currentPerformance) return;
  const ticket = currentTickets[index];
  if (!ticket) return;
  const { error } = await supabaseClient
    .from('tickets')
    .delete()
    .eq('id', ticket.id);
  if (error) {
    console.error('Error deleting ticket', error);
    return;
  }
  // Adjust counts
  const updateFields = {};
  if (ticket.type === 'CSAT') {
    updateFields.bad = Math.max(0, (currentPerformance.bad || 0) - 1);
  } else {
    updateFields.karma_bad = Math.max(0, (currentPerformance.karma_bad || 0) - 1);
  }
  const { data: updatedRow, error: updateErr } = await supabaseClient
    .from('performance_data')
    .update(updateFields)
    .eq('id', currentPerformance.id)
    .select()
    .single();
  if (!updateErr) {
    currentPerformance = updatedRow;
  }
  await loadTickets();
  updateUI();
}

/**
 * Compute CSAT and Karma metrics, plus the number of additional good ratings needed
 * to reach threshold targets (88%, 90%, 95%).
 */
function computeMetrics() {
  if (!currentPerformance) {
    return {
      csat: 0,
      karma: 0,
      needCsat: { 88: 0, 90: 0, 95: 0 },
      needKarma: { 88: 0, 90: 0, 95: 0 }
    };
  }
  const g = currentPerformance.good || 0;
  const b = currentPerformance.bad || 0;
  const k = currentPerformance.karma_bad || 0;
  // CSAT is good / (good + bad)
  const denomCsat = g + b;
  const csat = denomCsat > 0 ? (g / denomCsat) * 100 : 0;
  // Karma is good / (good + bad + karma_bad)
  const denomKarma = g + b + k;
  const karmaP = denomKarma > 0 ? (g / denomKarma) * 100 : 0;
  // Helper to calculate how many good ratings needed to reach a threshold
  function calcNeeded(threshold, includeKarma) {
    const t = threshold;
    let numerator;
    if (includeKarma) {
      numerator = t * g + t * b + t * k - g;
    } else {
      numerator = t * g + t * b - g;
    }
    const denom = 1 - t;
    let needed = 0;
    if (denom > 0) {
      needed = Math.ceil(numerator / denom);
    }
    return needed > 0 ? needed : 0;
  }
  const targets = [0.88, 0.90, 0.95];
  const needCsat = {};
  const needKarma = {};
  targets.forEach((thr) => {
    const per = Math.round(thr * 100);
    needCsat[per] = calcNeeded(thr, false);
    needKarma[per] = calcNeeded(thr, true);
  });
  return { csat: csat, karma: karmaP, needCsat: needCsat, needKarma: needKarma };
}

/**
 * Render the distribution of good and bad ratings by channel into the distribution card.
 */
function updateDistribution() {
  const distDiv = document.getElementById('distributionCard');
  if (!currentPerformance) {
    distDiv.innerHTML = '';
    return;
  }
  // Good counts for each channel
  const pg = currentPerformance.good_phone || 0;
  const cg = currentPerformance.good_chat || 0;
  const eg = currentPerformance.good_email || 0;
  const totalG = pg + cg + eg;
  const goodPercent = {
    Phone: totalG > 0 ? ((pg / totalG) * 100).toFixed(1) : '0',
    Chat: totalG > 0 ? ((cg / totalG) * 100).toFixed(1) : '0',
    Email: totalG > 0 ? ((eg / totalG) * 100).toFixed(1) : '0'
  };
  // Bad counts for each channel from tickets
  const badCounts = { Phone: 0, Chat: 0, Email: 0 };
  currentTickets.forEach((t) => {
    badCounts[t.channel] = (badCounts[t.channel] || 0) + 1;
  });
  const totalBad = badCounts.Phone + badCounts.Chat + badCounts.Email;
  const badPercent = {
    Phone: totalBad > 0 ? ((badCounts.Phone / totalBad) * 100).toFixed(1) : '0',
    Chat: totalBad > 0 ? ((badCounts.Chat / totalBad) * 100).toFixed(1) : '0',
    Email: totalBad > 0 ? ((badCounts.Email / totalBad) * 100).toFixed(1) : '0'
  };
  let html = '<h2>Channel Distribution</h2>';
  html += '<p><strong>Good:</strong> Phone ' + goodPercent.Phone + '%, Chat ' + goodPercent.Chat + '%, Email ' + goodPercent.Email + '%</p>';
  html += '<p><strong>Bad:</strong> Phone ' + badPercent.Phone + '%, Chat ' + badPercent.Chat + '%, Email ' + badPercent.Email + '%</p>';
  distDiv.innerHTML = html;
}

/**
 * Render per‑channel analytics including counts, CSAT/Karma rates and a progress bar.
 * Also draw a bar chart comparing counts across channels.
 */
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
  // Good counts per channel
  const goodCounts = {
    Phone: currentPerformance.good_phone || 0,
    Chat: currentPerformance.good_chat || 0,
    Email: currentPerformance.good_email || 0
  };
  // Separate CSAT bad and Karma bad counts per channel
  const csatBadCounts = { Phone: 0, Chat: 0, Email: 0 };
  const karmaBadCounts = { Phone: 0, Chat: 0, Email: 0 };
  currentTickets.forEach((t) => {
    if (t.type === 'CSAT') {
      csatBadCounts[t.channel] = (csatBadCounts[t.channel] || 0) + 1;
    } else {
      karmaBadCounts[t.channel] = (karmaBadCounts[t.channel] || 0) + 1;
    }
  });
  const channels = ['Phone', 'Chat', 'Email'];
  container.innerHTML = '';
  channels.forEach((ch) => {
    const g = goodCounts[ch] || 0;
    const csatB = csatBadCounts[ch] || 0;
    const karmaB = karmaBadCounts[ch] || 0;
    const total = g + csatB + karmaB;
    const goodP = total > 0 ? (g / total) * 100 : 0;
    const csatP = total > 0 ? (csatB / total) * 100 : 0;
    const karmaP = total > 0 ? (karmaB / total) * 100 : 0;
    // Card element using the new classes defined in style.css
    const card = document.createElement('div');
    card.className = 'channel-box';
    const title = document.createElement('h3');
    title.textContent = ch;
    const pGood = document.createElement('p');
    pGood.innerHTML = '<strong>Good:</strong> ' + g;
    const pCsat = document.createElement('p');
    pCsat.innerHTML = '<strong>CSAT Bad:</strong> ' + csatB;
    const pKarma = document.createElement('p');
    pKarma.innerHTML = '<strong>Karma Bad:</strong> ' + karmaB;
    // Compute CSAT and Karma rates per channel
    const csatRate = g + csatB > 0 ? ((g / (g + csatB)) * 100).toFixed(1) : '0';
    const karmaRate = g + csatB + karmaB > 0 ? ((g / (g + csatB + karmaB)) * 100).toFixed(1) : '0';
    const pRates = document.createElement('p');
    pRates.innerHTML = '<strong>CSAT:</strong> ' + csatRate + '% &nbsp; <strong>Karma:</strong> ' + karmaRate + '%';
    // Create progress bar container
    const bar = document.createElement('div');
    bar.className = 'progress';
    const segGood = document.createElement('span');
    segGood.className = 'good';
    segGood.style.width = goodP + '%';
    const segCsat = document.createElement('span');
    segCsat.className = 'csat';
    segCsat.style.width = csatP + '%';
    const segKarma = document.createElement('span');
    segKarma.className = 'karma';
    segKarma.style.width = karmaP + '%';
    bar.appendChild(segGood);
    bar.appendChild(segCsat);
    bar.appendChild(segKarma);
    // Assemble card
    card.appendChild(title);
    card.appendChild(pGood);
    card.appendChild(pCsat);
    card.appendChild(pKarma);
    card.appendChild(pRates);
    card.appendChild(bar);
    container.appendChild(card);
  });
  // Chart dataset for overall comparison across channels
  const data = {
    labels: channels,
    datasets: [
      {
        label: 'Good',
        data: [goodCounts.Phone, goodCounts.Chat, goodCounts.Email],
        backgroundColor: 'rgba(16, 185, 129, 0.7)',
        borderColor: 'rgba(16, 185, 129, 1)',
        borderWidth: 1
      },
      {
        label: 'CSAT Bad',
        data: [csatBadCounts.Phone, csatBadCounts.Chat, csatBadCounts.Email],
        backgroundColor: 'rgba(239, 68, 68, 0.7)',
        borderColor: 'rgba(239, 68, 68, 1)',
        borderWidth: 1
      },
      {
        label: 'Karma Bad',
        data: [karmaBadCounts.Phone, karmaBadCounts.Chat, karmaBadCounts.Email],
        backgroundColor: 'rgba(168, 85, 247, 0.7)',
        borderColor: 'rgba(168, 85, 247, 1)',
        borderWidth: 1
      }
    ]
  };
  const ctx = document.getElementById('channelChart').getContext('2d');
  if (channelChart) {
    channelChart.destroy();
  }
  channelChart = new Chart(ctx, {
    type: 'bar',
    data: data,
    options: {
      responsive: true,
      scales: {
        y: {
          beginAtZero: true,
          title: { display: true, text: 'Count' }
        }
      }
    }
  });
}

/**
 * Render overall performance metrics into the metrics card.
 */
function updateMetrics() {
  const card = document.getElementById('metricsCard');
  if (!currentPerformance) {
    card.innerHTML = '';
    return;
  }
  const metrics = computeMetrics();
  let html = '<h2>Performance Metrics</h2>';
  html += '<p><strong>CSAT:</strong> ' + metrics.csat.toFixed(1) + '% &nbsp; <strong>Karma:</strong> ' + metrics.karma.toFixed(1) + '%</p>';
  html += '<p style="margin-top:0.5rem;"><strong>Good ratings needed to reach targets:</strong></p>';
  for (const per in metrics.needCsat) {
    html += '<p>' + per + '% CSAT: ' + metrics.needCsat[per] + ' &nbsp; | &nbsp; ' + per + '% Karma: ' + metrics.needKarma[per] + '</p>';
  }
  card.innerHTML = html;
}

/**
 * Render the tickets table with current tickets and remove buttons.
 */
function updateTicketsTable() {
  const tbody = document.getElementById('ticketsTable').querySelector('tbody');
  tbody.innerHTML = '';
  currentTickets.forEach((t, idx) => {
    const tr = document.createElement('tr');
    const tdIndex = document.createElement('td');
    tdIndex.textContent = idx + 1;
    const tdLink = document.createElement('td');
    // If the ticket looks like a URL, render as a link
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
    const tdAct = document.createElement('td');
    const btn = document.createElement('button');
    btn.className = 'btn-delete';
    btn.textContent = 'Remove';
    btn.onclick = function() { removeTicket(idx); };
    tdAct.appendChild(btn);
    tr.appendChild(tdIndex);
    tr.appendChild(tdLink);
    tr.appendChild(tdType);
    tr.appendChild(tdChannel);
    tr.appendChild(tdNote);
    tr.appendChild(tdAct);
    tbody.appendChild(tr);
  });
}

/**
 * Update all UI elements based on current state.
 */
function updateUI() {
  if (!currentPerformance) {
    // Clear values if no performance row is loaded
    document.getElementById('goodValue').textContent = '0';
    document.getElementById('badValue').textContent = '0';
    document.getElementById('karmaValue').textContent = '0';
    document.getElementById('phoneGood').value = '0';
    document.getElementById('chatGood').value = '0';
    document.getElementById('emailGood').value = '0';
    document.getElementById('metricsCard').innerHTML = '';
    document.getElementById('distributionCard').innerHTML = '';
    document.getElementById('channelAnalyticsContent').innerHTML = '';
    document.getElementById('ticketsTable').querySelector('tbody').innerHTML = '';
    if (channelChart) {
      channelChart.destroy();
      channelChart = null;
    }
    return;
  }
  document.getElementById('goodValue').textContent = currentPerformance.good || 0;
  document.getElementById('badValue').textContent = currentPerformance.bad || 0;
  document.getElementById('karmaValue').textContent = currentPerformance.karma_bad || 0;
  document.getElementById('phoneGood').value = currentPerformance.good_phone || 0;
  document.getElementById('chatGood').value = currentPerformance.good_chat || 0;
  document.getElementById('emailGood').value = currentPerformance.good_email || 0;
  updateTicketsTable();
  updateMetrics();
  updateDistribution();
  updateChannelAnalytics();
}

/**
 * Initialise the page: populate years, set current month, attach events and load initial data.
 */
function init() {
  populateYears();
  const currentMonth = new Date().getMonth() + 1;
  document.getElementById('monthSelect').value = currentMonth.toString();
  document.getElementById('loadBtn').addEventListener('click', loadMonth);
  loadMonth();
}

// Fire the init function when the DOM content is loaded
document.addEventListener('DOMContentLoaded', init);