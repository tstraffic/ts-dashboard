// Worker portal training — personal quiz mode.
// Worker takes the quiz on their phone (skipping the slides since they've been
// through the in-person induction). Gated by employees.online_training_allowed
// which the admin grants from the employee profile.
const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');
const { employeeGuideSlides, tcTrainingSlides } = require('../../induction-slides');
const { maybeMarkInducted } = require('../../lib/induction');

const MODULES = {
  'employee-guide': { slides: employeeGuideSlides, title: 'T&S Employee Guide', key: 'employee_guide' },
  'traffic-control': { slides: tcTrainingSlides, title: 'TC Training — Module 1', key: 'tc_training_1' },
};

function quizFromSlides(slides) {
  return slides.filter(s => s.layout === 'interactive-quiz' && s.quizData).map(s => s.quizData);
}

// Look up the employee record + permission for the logged-in worker.
function workerEmployee(db, workerId) {
  return db.prepare(`
    SELECT id, full_name, email, online_training_allowed, inducted_at, linked_crew_member_id
    FROM employees
    WHERE linked_crew_member_id = ? AND deleted_at IS NULL
    ORDER BY id DESC LIMIT 1
  `).get(workerId);
}

// GET /w/training — list of modules with status
router.get('/training', (req, res) => {
  const db = getDb();
  const employee = workerEmployee(db, req.session.worker.id);

  const modules = Object.entries(MODULES).map(([slug, cfg]) => {
    let status = null;
    if (employee) {
      const pass = db.prepare(
        "SELECT id, completed_at, score, total FROM training_completions WHERE employee_id = ? AND module = ? AND passed = 1 ORDER BY completed_at DESC LIMIT 1"
      ).get(employee.id, cfg.key);
      status = pass || null;
    }
    return { slug, title: cfg.title, key: cfg.key, totalQuestions: quizFromSlides(cfg.slides).length, passed: !!status, lastPass: status };
  });

  res.render('worker/training-index', {
    title: 'Training',
    currentPage: 'training',
    modules,
    accessAllowed: !!(employee && employee.online_training_allowed),
    inductedAt: employee ? employee.inducted_at : null,
    worker: req.session.worker,
  });
});

// GET /w/training/:slug — present the quiz
router.get('/training/:slug', (req, res) => {
  const cfg = MODULES[req.params.slug];
  if (!cfg) { req.flash('error', 'Unknown training module.'); return res.redirect('/w/training'); }

  const db = getDb();
  const employee = workerEmployee(db, req.session.worker.id);
  if (!employee || !employee.online_training_allowed) {
    return res.render('worker/training-locked', {
      title: 'Training', currentPage: 'training',
      worker: req.session.worker,
    });
  }

  const questions = quizFromSlides(cfg.slides);
  res.render('worker/training-quiz', {
    title: cfg.title,
    currentPage: 'training',
    moduleSlug: req.params.slug,
    moduleTitle: cfg.title,
    moduleKey: cfg.key,
    questions,
    worker: req.session.worker,
  });
});

// POST /w/training/:slug/submit — score quiz + record completion
router.post('/training/:slug/submit', (req, res) => {
  const cfg = MODULES[req.params.slug];
  if (!cfg) return res.status(404).json({ ok: false, error: 'Unknown module' });

  const db = getDb();
  const employee = workerEmployee(db, req.session.worker.id);
  if (!employee || !employee.online_training_allowed) {
    return res.status(403).json({ ok: false, error: 'Online training is not enabled for your account. Speak to your supervisor.' });
  }

  const questions = quizFromSlides(cfg.slides);
  const answers = (req.body && req.body.answers) || {};
  let correct = 0;
  const breakdown = [];
  for (const q of questions) {
    const userAnswer = answers[q.questionNumber] || null;
    const isCorrect = userAnswer === q.correctAnswer;
    if (isCorrect) correct += 1;
    const correctText = (q.options.find(o => o.id === q.correctAnswer) || {}).text || '';
    breakdown.push({ questionNumber: q.questionNumber, question: q.question, isCorrect, correctAnswer: correctText });
  }
  const total = questions.length;
  const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
  const passed = pct >= 90;

  db.prepare(`
    INSERT INTO training_completions (employee_id, module, full_name, email, score, total, passed)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(employee.id, cfg.key, employee.full_name, employee.email || '', correct, total, passed ? 1 : 0);

  if (passed) {
    try { maybeMarkInducted(db, employee.id, 'online'); } catch (e) { console.error('maybeMarkInducted failed:', e.message); }
  }

  res.json({ ok: true, correct, total, pct, passed, breakdown });
});

module.exports = router;
