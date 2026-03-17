// T&S Traffic Control — Hard Induction Slide Content
// Used by the presenter view for projector-based training sessions

const employeeGuideSlides = [
  {
    title: 'T&S Employee Guide',
    subtitle: '"A Safe Way Home"',
    content: '<div class="text-center"><p class="text-2xl text-blue-200 mb-4">Module 1</p><p class="text-lg text-blue-300">Welcome to T&S Traffic Control</p></div>',
    layout: 'title',
    icon: '📘'
  },
  {
    title: 'Our Mission',
    subtitle: 'Family-owned since 2021',
    content: '<div class="grid md:grid-cols-2 gap-8"><div><p class="text-xl leading-relaxed mb-4">T&S Traffic Control — <strong>"A Safe Way Home."</strong></p><p class="text-lg text-blue-200">Raising standards of safety, professionalism, and respect in NSW traffic control.</p></div><div class="bg-white/10 rounded-2xl p-6"><p class="text-lg mb-3 font-semibold">What drives us:</p><ul class="space-y-3 text-blue-100"><li class="flex items-start gap-3"><span class="text-green-400 text-xl">✓</span> ISO-certified operations</li><li class="flex items-start gap-3"><span class="text-green-400 text-xl">✓</span> Built to make a difference</li><li class="flex items-start gap-3"><span class="text-green-400 text-xl">✓</span> Protecting lives every day</li></ul></div></div>',
    layout: 'split',
    icon: '🎯'
  },
  {
    title: 'Who We Are',
    subtitle: '',
    content: '<div class="max-w-3xl mx-auto"><p class="text-xl leading-relaxed mb-6">What began as a small team built on strong values has grown into a trusted traffic control company known for <strong>integrity, precision, and care.</strong></p><p class="text-lg text-blue-200 mb-6">We founded T&S to raise the standard of safety and respect in our industry — not just to offer a service.</p><div class="bg-white/10 rounded-2xl p-6"><p class="text-lg font-medium text-blue-100">Our mission is to <strong>protect lives</strong> and create a workplace where every team member can <strong>grow, lead, and deliver safe outcomes</strong> for the public, workers, and pedestrians.</p></div></div>',
    layout: 'content',
    icon: '🏢'
  },
  {
    title: 'Meet Our Founders',
    subtitle: 'Taj & Saadat',
    content: '<div class="max-w-3xl mx-auto"><div class="bg-white/10 rounded-2xl p-8"><p class="text-xl leading-relaxed mb-4">Lifelong friends turned business partners, they founded the company with a shared vision — to lift the standard of safety, professionalism, and opportunity.</p><p class="text-lg text-blue-200 mb-4">From humble beginnings, they built T&S through hard work, trust, and a deep sense of responsibility to both clients and their team.</p><p class="text-lg text-blue-100">Their leadership goes beyond operations — they\'re dedicated to building a workplace that <strong>develops, supports, and empowers</strong> people to grow, lead, and succeed.</p></div></div>',
    layout: 'content',
    icon: '👥'
  },
  {
    title: 'What We\'ve Accomplished',
    subtitle: 'Major Projects',
    content: '<div class="grid md:grid-cols-3 gap-6"><div class="bg-white/10 rounded-xl p-6 text-center"><div class="text-4xl mb-3">🏗️</div><p class="font-bold text-lg mb-2">Hospital Roundabout</p><p class="text-blue-200">Concord Hospital Roundabout & Stormwater Upgrade Project</p></div><div class="bg-white/10 rounded-xl p-6 text-center"><div class="text-4xl mb-3">🏨</div><p class="font-bold text-lg mb-2">Hotel Construction</p><p class="text-blue-200">Wentworth Avenue Hotel Construction Traffic Management</p></div><div class="bg-white/10 rounded-xl p-6 text-center"><div class="text-4xl mb-3">🛣️</div><p class="font-bold text-lg mb-2">Road Upgrades</p><p class="text-blue-200">Wallendbeen Road Pavement Upgrade Project</p></div></div>',
    layout: 'split',
    icon: '🏆'
  },
  {
    title: 'Legal Responsibilities',
    subtitle: 'Know your obligations',
    content: '<div class="grid md:grid-cols-3 gap-6"><div class="bg-white/10 rounded-xl p-6 border-l-4 border-blue-400"><div class="text-3xl font-bold text-blue-400 mb-2">1</div><p class="font-semibold mb-2">Valid Credentials</p><p class="text-blue-200">Hold a valid White Card and Traffic Controller RMS/TfNSW accreditation at all times.</p></div><div class="bg-white/10 rounded-xl p-6 border-l-4 border-green-400"><div class="text-3xl font-bold text-green-400 mb-2">2</div><p class="font-semibold mb-2">WHS Compliance</p><p class="text-blue-200">Follow the WHS Act 2011 (NSW) and all RMS/TfNSW standards.</p></div><div class="bg-white/10 rounded-xl p-6 border-l-4 border-amber-400"><div class="text-3xl font-bold text-amber-400 mb-2">3</div><p class="font-semibold mb-2">Documentation</p><p class="text-blue-200">Read and sign all SWMS and TMP before work (when required).</p></div></div>',
    layout: 'split',
    icon: '⚖️'
  },
  {
    title: 'Company Values & Behaviour',
    subtitle: 'How we operate',
    content: '<div class="grid grid-cols-2 gap-6"><div class="bg-white/10 rounded-xl p-6"><p class="text-2xl mb-2">🤝</p><p class="font-bold text-lg mb-2">Respect</p><p class="text-blue-200">Respect colleagues and the public at all times.</p></div><div class="bg-white/10 rounded-xl p-6"><p class="text-2xl mb-2">🚨</p><p class="font-bold text-lg mb-2">Report</p><p class="text-blue-200">Report unsafe actions or incidents immediately to admin.</p></div><div class="bg-white/10 rounded-xl p-6"><p class="text-2xl mb-2">🚫</p><p class="font-bold text-lg mb-2">Zero Tolerance</p><p class="text-blue-200">Zero tolerance for all forms of harassment or bullying.</p></div><div class="bg-white/10 rounded-xl p-6"><p class="text-2xl mb-2">💼</p><p class="font-bold text-lg mb-2">Professional</p><p class="text-blue-200">Keep sites professional — no relationships between supervisors and subordinates.</p></div></div>',
    layout: 'split',
    icon: '💎'
  },
  {
    title: 'Wear the Correct PPE — Every Time!',
    subtitle: 'Your last line of defence',
    content: '<div class="text-center"><p class="text-xl text-blue-200 mb-8">PPE protects you from traffic, machinery and weather. It is a <strong>legal requirement</strong> under NSW WHS regulations.</p><div class="grid md:grid-cols-3 gap-6 max-w-3xl mx-auto"><div class="bg-amber-500/20 border border-amber-500/40 rounded-xl p-6"><p class="text-3xl mb-2">👷</p><p class="font-bold">Hard Hat</p><p class="text-sm text-blue-200">All job sites</p></div><div class="bg-green-500/20 border border-green-500/40 rounded-xl p-6"><p class="text-3xl mb-2">🦺</p><p class="font-bold">Hi-Vis Clothing</p><p class="text-sm text-blue-200">Class D/N day & night</p></div><div class="bg-blue-500/20 border border-blue-500/40 rounded-xl p-6"><p class="text-3xl mb-2">🥾</p><p class="font-bold">Steel-Cap Boots</p><p class="text-sm text-blue-200">Ankle-supportive, slip-resistant</p></div></div></div>',
    layout: 'highlight',
    icon: '🦺'
  },
  {
    title: 'PPE Compliance',
    subtitle: '',
    content: '<div class="max-w-3xl mx-auto"><div class="bg-white/10 rounded-xl p-6 mb-6"><p class="font-bold text-lg mb-3">Optional PPE (when required):</p><ul class="grid grid-cols-2 gap-3 text-blue-200"><li>🧤 Gloves — handling equipment, extreme weather</li><li>🥽 Safety glasses — dust, debris, sun glare</li><li>🎧 Hearing protection — near loud machinery</li><li>🧥 Wet-weather gear — adverse conditions</li></ul></div><div class="bg-red-500/20 border border-red-500/40 rounded-xl p-6"><p class="text-xl font-bold text-red-300 mb-2">⚠️ Compliance & Disciplinary Actions</p><p class="text-lg">Failure to wear PPE correctly can result in <strong>warnings, suspension, or removal from site.</strong></p><p class="text-blue-200 mt-2">Always follow supervisor instructions regarding PPE requirements.</p></div></div>',
    layout: 'content',
    icon: '⚠️'
  },
  {
    title: 'Allocations & Traffio',
    subtitle: 'How you get your shifts',
    content: '<div class="max-w-3xl mx-auto"><p class="text-xl text-blue-200 mb-6">Traffio is our app for allocating and rostering all employees. It provides job site info, resources, location, TGS, ROL and all safety documents.</p><div class="bg-white/10 rounded-xl p-6 space-y-4"><div class="flex items-start gap-4"><div class="w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center font-bold flex-shrink-0">1</div><div><p class="font-semibold">Log in details sent to your email</p></div></div><div class="flex items-start gap-4"><div class="w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center font-bold flex-shrink-0">2</div><div><p class="font-semibold">Receive allocations per day for the following day</p></div></div><div class="flex items-start gap-4"><div class="w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center font-bold flex-shrink-0">3</div><div><p class="font-semibold">Accept or reject the shift — if you reject, notify your allocator</p></div></div><div class="flex items-start gap-4"><div class="w-8 h-8 bg-red-500 rounded-full flex items-center justify-center font-bold flex-shrink-0">!</div><div><p class="font-semibold text-red-300">ALL employees must have notifications ON!</p></div></div></div></div>',
    layout: 'content',
    icon: '📱'
  },
  {
    title: 'Job Flow — 6 Steps',
    subtitle: 'From booking to timesheet',
    content: '<div class="grid md:grid-cols-3 gap-4"><div class="bg-white/10 rounded-xl p-5 text-center"><div class="text-2xl font-bold text-blue-400 mb-2">Step 1</div><p class="font-semibold">Receive Job Request</p><p class="text-sm text-blue-200 mt-1">Booking time = start time on site</p></div><div class="bg-white/10 rounded-xl p-5 text-center"><div class="text-2xl font-bold text-blue-400 mb-2">Step 2</div><p class="font-semibold">Review & Accept</p><p class="text-sm text-blue-200 mt-1">Check details and confirm</p></div><div class="bg-white/10 rounded-xl p-5 text-center"><div class="text-2xl font-bold text-blue-400 mb-2">Step 3</div><p class="font-semibold">Read Description</p><p class="text-sm text-blue-200 mt-1">Contact crew booking</p></div><div class="bg-white/10 rounded-xl p-5 text-center"><div class="text-2xl font-bold text-green-400 mb-2">Step 4</div><p class="font-semibold">Review Site Docs</p><p class="text-sm text-blue-200 mt-1">All safety documentation</p></div><div class="bg-white/10 rounded-xl p-5 text-center"><div class="text-2xl font-bold text-green-400 mb-2">Step 5</div><p class="font-semibold">Fill Checklists</p><p class="text-sm text-blue-200 mt-1">Complete during every job</p></div><div class="bg-white/10 rounded-xl p-5 text-center"><div class="text-2xl font-bold text-green-400 mb-2">Step 6</div><p class="font-semibold">Submit Timesheet</p><p class="text-sm text-blue-200 mt-1">Client MUST sign timesheet</p></div></div>',
    layout: 'split',
    icon: '📋'
  },
  {
    title: 'Accessible Forms',
    subtitle: 'Via Traffio app',
    content: '<div class="max-w-3xl mx-auto"><p class="text-lg text-blue-200 mb-6">On the bottom of the Traffio screen, tap the "Forms" tab. Always submit a form and follow up with your supervisor via phone call.</p><div class="grid md:grid-cols-2 gap-4"><div class="bg-white/10 rounded-xl p-5 flex items-center gap-4"><span class="text-2xl">🏖️</span><div><p class="font-semibold">Leave Request</p><p class="text-sm text-blue-200">Submit at least 2 days before</p></div></div><div class="bg-white/10 rounded-xl p-5 flex items-center gap-4"><span class="text-2xl">⚠️</span><div><p class="font-semibold">Near-Miss Report</p><p class="text-sm text-blue-200">Report immediately</p></div></div><div class="bg-white/10 rounded-xl p-5 flex items-center gap-4"><span class="text-2xl">🚑</span><div><p class="font-semibold">Accident Report</p><p class="text-sm text-blue-200">Complete as soon as possible</p></div></div><div class="bg-white/10 rounded-xl p-5 flex items-center gap-4"><span class="text-2xl">📸</span><div><p class="font-semibold">Extra Site Photos</p><p class="text-sm text-blue-200">Upload for documentation</p></div></div></div></div>',
    layout: 'content',
    icon: '📝'
  },
  {
    title: 'Representing T&S On Site',
    subtitle: 'Verbal expectations',
    content: '<div class="max-w-3xl mx-auto"><p class="text-xl mb-6">At T&S, we expect our traffic controllers to treat all road users, pedestrians and clients with <strong>utmost respect and manners.</strong></p><div class="space-y-4"><div class="bg-green-500/20 rounded-xl p-5 border-l-4 border-green-400"><p class="text-lg italic">"Good morning/afternoon! Please wait here for a moment; I\'ll let you know when it\'s safe to go."</p></div><div class="bg-green-500/20 rounded-xl p-5 border-l-4 border-green-400"><p class="text-lg italic">"Alright, you\'re good to go! Watch your step and have a great day!"</p></div><div class="bg-green-500/20 rounded-xl p-5 border-l-4 border-green-400"><p class="text-lg italic">"Thanks for your patience! You can cross now — stay safe!"</p></div></div><p class="text-lg text-blue-200 mt-6 text-center">Being polite and using a friendly tone creates an <strong>impactful difference.</strong></p></div>',
    layout: 'content',
    icon: '💬'
  },
  {
    title: 'Mobile Phone Policy',
    subtitle: 'Zero tolerance on site',
    content: '<div class="max-w-3xl mx-auto"><div class="bg-red-500/20 border border-red-500/40 rounded-2xl p-8 text-center mb-6"><p class="text-5xl mb-4">📵</p><p class="text-2xl font-bold text-red-300">NO PHONES ON SITE</p></div><div class="grid md:grid-cols-2 gap-4"><div class="bg-white/10 rounded-xl p-5"><p class="font-semibold text-red-300 mb-1">Reduced Awareness</p><p class="text-blue-200">Must remain fully focused on vehicle and pedestrian movements</p></div><div class="bg-white/10 rounded-xl p-5"><p class="font-semibold text-red-300 mb-1">Delayed Reactions</p><p class="text-blue-200">A momentary distraction can lead to accidents</p></div><div class="bg-white/10 rounded-xl p-5"><p class="font-semibold text-red-300 mb-1">Miscommunication</p><p class="text-blue-200">Missed radio communications or misunderstood instructions</p></div><div class="bg-white/10 rounded-xl p-5"><p class="font-semibold text-red-300 mb-1">Legal Issues</p><p class="text-blue-200">NSW regulations require full alertness — fines, termination, or liability</p></div></div></div>',
    layout: 'highlight',
    icon: '📵'
  },
  {
    title: 'Driving Expectations',
    subtitle: 'Vehicle safety & compliance',
    content: '<div class="grid md:grid-cols-3 gap-6"><div class="bg-white/10 rounded-xl p-6"><p class="text-xl font-bold text-blue-400 mb-3">1. Pre-Start</p><ul class="space-y-2 text-blue-200"><li>✓ Check lights, brakes, fuel, oil, tyres</li><li>✓ Verify traffic control equipment</li><li>✓ Secure all tools and equipment</li><li>✓ Always wear a seatbelt</li></ul></div><div class="bg-white/10 rounded-xl p-6"><p class="text-xl font-bold text-green-400 mb-3">2. Defensive Driving</p><ul class="space-y-2 text-blue-200"><li>✓ Follow all road rules and speed limits</li><li>✓ Drive to weather conditions</li><li>✓ Maintain safe following distance</li><li>✓ Stay alert near work zones</li></ul></div><div class="bg-white/10 rounded-xl p-6"><p class="text-xl font-bold text-amber-400 mb-3">3. Warning Signals</p><ul class="space-y-2 text-blue-200"><li>✓ Activate beacons near traffic zones</li><li>✓ Use indicators early</li><li>✓ Only use horn when necessary</li></ul></div></div>',
    layout: 'split',
    icon: '🚗'
  },
  {
    title: 'T&S Vehicle Rules',
    subtitle: 'Must follow at all times',
    content: '<div class="max-w-3xl mx-auto space-y-4"><div class="bg-white/10 rounded-xl p-5 flex items-center gap-4"><span class="text-2xl">📏</span><p>Maximum vehicle height is <strong>2.5 metres</strong></p></div><div class="bg-white/10 rounded-xl p-5 flex items-center gap-4"><span class="text-2xl">🅿️</span><p>No parking in car parks or near shops</p></div><div class="bg-white/10 rounded-xl p-5 flex items-center gap-4"><span class="text-2xl">🚛</span><p>Utes must remain on site — no leaving unless client grants permission</p></div><div class="bg-white/10 rounded-xl p-5 flex items-center gap-4"><span class="text-2xl">🚭</span><p>No eating or smoking inside company vehicles</p></div><div class="bg-red-500/20 border border-red-500/40 rounded-xl p-5"><p class="font-bold text-red-300 mb-2">⚠️ Accident Liability</p><p class="text-blue-200">Report must be completed immediately in Traffio. If driver at fault: vehicle insurance excess is <strong>$2,000</strong> (under 25). Cage/arrowboard excess is <strong>$1,000</strong> (under 25).</p></div></div>',
    layout: 'list',
    icon: '🚛'
  },
  {
    title: 'Road Rules in a T&S Vehicle',
    subtitle: '',
    content: '<div class="max-w-3xl mx-auto"><div class="grid md:grid-cols-2 gap-6"><div class="bg-white/10 rounded-xl p-6"><p class="text-4xl text-center mb-4">🛣️</p><p class="text-center font-bold text-lg mb-2">Lane Discipline</p><p class="text-blue-200 text-center">On highways, drive <strong>only in the slow or middle lanes.</strong> Never use the fast (right-hand) lane under any circumstances.</p></div><div class="bg-white/10 rounded-xl p-6"><p class="text-4xl text-center mb-4">🐢</p><p class="text-center font-bold text-lg mb-2">Speed Management</p><p class="text-blue-200 text-center">Maintain a speed approximately <strong>10 km/h below the posted limit.</strong> Your vehicle carries up to 500 kg of load.</p></div></div><div class="bg-amber-500/20 border border-amber-500/40 rounded-xl p-6 mt-6 text-center"><p class="text-lg font-bold text-amber-300">Avoid harsh braking — your vehicle carries up to 500 kg of load weight at all times.</p></div></div>',
    layout: 'split',
    icon: '🚦'
  },
  {
    title: 'Harassment & Relationships',
    subtitle: 'Zero tolerance policy',
    content: '<div class="max-w-3xl mx-auto"><div class="bg-red-500/20 border border-red-500/40 rounded-xl p-6 mb-6"><p class="text-xl font-bold text-red-300 mb-3">Sexual Harassment Policy</p><ul class="space-y-2 text-blue-200"><li>🚫 Zero tolerance for inappropriate jokes, comments, touching, or advances</li><li>🔒 Any report is taken seriously and investigated confidentially</li><li>⚖️ Offenders may be removed from site or face termination</li></ul></div><div class="bg-white/10 rounded-xl p-6 mb-6"><p class="font-bold text-lg mb-3">Relationships on Site</p><ul class="space-y-2 text-blue-200"><li>• Romantic relationships must be declared to management</li><li>• No displays of affection on site — keep it professional</li><li>• Managers/supervisors cannot be in relationships with direct subordinates</li></ul></div><div class="bg-blue-500/20 rounded-xl p-5 text-center"><p class="font-semibold">Speak to HR or the designated contact officer if you feel unsafe. Anonymous reports can also be made.</p></div></div>',
    layout: 'content',
    icon: '🛡️'
  },
  {
    title: 'First Aid & Safety',
    subtitle: 'Know where everything is',
    content: '<div class="grid md:grid-cols-2 gap-6 max-w-3xl mx-auto"><div class="bg-red-500/20 border border-red-500/40 rounded-xl p-6 text-center"><p class="text-4xl mb-3">🧯</p><p class="font-bold text-lg mb-2">Fire Extinguisher</p><p class="text-blue-200">Located on the ute\'s cage — passenger side</p></div><div class="bg-green-500/20 border border-green-500/40 rounded-xl p-6 text-center"><p class="text-4xl mb-3">🩹</p><p class="font-bold text-lg mb-2">First Aid Kit</p><p class="text-blue-200">Passenger side glove box or behind passenger seat</p></div><div class="bg-amber-500/20 border border-amber-500/40 rounded-xl p-6 text-center"><p class="text-4xl mb-3">⛽</p><p class="font-bold text-lg mb-2">Fuel Card</p><p class="text-blue-200">Sunglass holder, glove box or centre console — T&S VEHICLE USE ONLY</p></div><div class="bg-blue-500/20 border border-blue-500/40 rounded-xl p-6 text-center"><p class="text-4xl mb-3">🔑</p><p class="font-bold text-lg mb-2">Keys</p><p class="text-blue-200">Must go into the lock box, next to stop/slow bats</p></div></div>',
    layout: 'split',
    icon: '🩹'
  },
  {
    title: 'Fire Extinguisher — PASS Method',
    subtitle: 'Remember these 4 steps',
    content: '<div class="grid md:grid-cols-4 gap-4 max-w-4xl mx-auto"><div class="bg-red-500/20 border border-red-500/40 rounded-xl p-6 text-center"><p class="text-4xl font-bold text-red-400 mb-2">P</p><p class="font-bold text-lg mb-2">PULL</p><p class="text-blue-200">Pull pin at the top, breaking the seal. Test aiming away from you.</p></div><div class="bg-amber-500/20 border border-amber-500/40 rounded-xl p-6 text-center"><p class="text-4xl font-bold text-amber-400 mb-2">A</p><p class="font-bold text-lg mb-2">AIM</p><p class="text-blue-200">Approach from a safe distance. Aim at the base of the fire.</p></div><div class="bg-green-500/20 border border-green-500/40 rounded-xl p-6 text-center"><p class="text-4xl font-bold text-green-400 mb-2">S</p><p class="font-bold text-lg mb-2">SQUEEZE</p><p class="text-blue-200">Squeeze handles together to discharge. Release to stop.</p></div><div class="bg-blue-500/20 border border-blue-500/40 rounded-xl p-6 text-center"><p class="text-4xl font-bold text-blue-400 mb-2">S</p><p class="font-bold text-lg mb-2">SWEEP</p><p class="text-blue-200">Sweep nozzle side to side at the base of the flames.</p></div></div>',
    layout: 'split',
    icon: '🧯'
  },
  {
    title: 'Module 1 Quiz',
    subtitle: 'Test your knowledge',
    content: '<div class="grid md:grid-cols-2 gap-6 max-w-3xl mx-auto"><div class="bg-white/10 rounded-xl p-6 border-l-4 border-blue-400"><p class="text-lg font-bold mb-2">Question 1</p><p class="text-blue-200">What is the compulsory PPE for every job site?</p></div><div class="bg-white/10 rounded-xl p-6 border-l-4 border-green-400"><p class="text-lg font-bold mb-2">Question 2</p><p class="text-blue-200">What is the company motto?</p></div><div class="bg-white/10 rounded-xl p-6 border-l-4 border-amber-400"><p class="text-lg font-bold mb-2">Question 3</p><p class="text-blue-200">Where is the fire extinguisher located on every ute?</p></div><div class="bg-white/10 rounded-xl p-6 border-l-4 border-red-400"><p class="text-lg font-bold mb-2">Question 4</p><p class="text-blue-200">How many days earlier should you notify the company about short-term leave?</p></div></div>',
    layout: 'quiz',
    icon: '❓'
  },
];

const tcTrainingSlides = [
  {
    title: 'Traffic Control',
    subtitle: 'Training Module 1',
    content: '<div class="text-center"><p class="text-2xl text-amber-200 mb-4">Field Operations & Safety</p><p class="text-lg text-amber-300">Your complete guide to traffic control in the field</p></div>',
    layout: 'title',
    icon: '🚧'
  },
  {
    title: '1. Start of Shift',
    subtitle: 'What to do when arriving to site',
    content: '<div class="grid md:grid-cols-3 gap-4"><div class="bg-white/10 rounded-xl p-5 text-center"><p class="text-3xl mb-2">🪪</p><p class="font-bold">Credentials</p><p class="text-amber-200 text-sm">Must have White Card, TCR & IMP Safe Work Card</p></div><div class="bg-white/10 rounded-xl p-5 text-center"><p class="text-3xl mb-2">⏰</p><p class="font-bold">15 Min Early</p><p class="text-amber-200 text-sm">Arrive 15 minutes before booking time</p></div><div class="bg-white/10 rounded-xl p-5 text-center"><p class="text-3xl mb-2">🦺</p><p class="font-bold">Full PPE</p><p class="text-amber-200 text-sm">Must be in full PPE before arriving</p></div><div class="bg-white/10 rounded-xl p-5 text-center"><p class="text-3xl mb-2">✅</p><p class="font-bold">Pre-Start</p><p class="text-amber-200 text-sm">Sign onto Pre-Start Checklist on Traffio</p></div><div class="bg-white/10 rounded-xl p-5 text-center"><p class="text-3xl mb-2">📋</p><p class="font-bold">SWMS</p><p class="text-amber-200 text-sm">Sign onto T&S SWMS and with client</p></div><div class="bg-white/10 rounded-xl p-5 text-center"><p class="text-3xl mb-2">👋</p><p class="font-bold">Notify</p><p class="text-amber-200 text-sm">Notify Team Leader and Site Manager</p></div></div>',
    layout: 'split',
    icon: '🌅'
  },
  {
    title: 'What is SWMS?',
    subtitle: 'Safe Work Method Statement',
    content: '<div class="max-w-3xl mx-auto"><div class="bg-white/10 rounded-xl p-6 mb-6"><p class="text-xl font-bold mb-4">Purpose & Importance</p><ul class="space-y-3 text-lg"><li class="flex items-start gap-3"><span class="text-green-400">✓</span> <strong>Identifies Risks</strong> — Lists hazards for specific tasks</li><li class="flex items-start gap-3"><span class="text-green-400">✓</span> <strong>Implements Controls</strong> — How risks are minimised or eliminated</li><li class="flex items-start gap-3"><span class="text-green-400">✓</span> <strong>Ensures Compliance</strong> — Meets NSW WHS laws</li><li class="flex items-start gap-3"><span class="text-green-400">✓</span> <strong>Protects Workers</strong> — Reduces accidents and injuries</li></ul></div><div class="bg-red-500/20 border border-red-500/40 rounded-xl p-5"><p class="font-bold text-red-300">If hazards are not controlled effectively, work must STOP immediately.</p></div></div>',
    layout: 'content',
    icon: '📄'
  },
  {
    title: 'Road Occupancy Licence (ROL)',
    subtitle: 'When and how to activate',
    content: '<div class="max-w-3xl mx-auto"><div class="bg-amber-500/20 border border-amber-500/40 rounded-xl p-6 mb-6 text-center"><p class="text-xl font-bold text-amber-300">MUST have an ROL for any works within 50m of a traffic light or main RMS road</p></div><div class="bg-white/10 rounded-xl p-6 space-y-4"><div class="flex items-start gap-4"><div class="w-8 h-8 bg-amber-500 rounded-full flex items-center justify-center font-bold flex-shrink-0">1</div><p>Search <strong>myrol.transport.nsw.gov.au</strong> and answer questions to activate</p></div><div class="flex items-start gap-4"><div class="w-8 h-8 bg-amber-500 rounded-full flex items-center justify-center font-bold flex-shrink-0">2</div><p>Read ALL Licence Conditions and observe approved dates & times</p></div><div class="flex items-start gap-4"><div class="w-8 h-8 bg-amber-500 rounded-full flex items-center justify-center font-bold flex-shrink-0">3</div><p>Activate BEFORE commencing setup — deactivate at end of shift</p></div><div class="flex items-start gap-4"><div class="w-8 h-8 bg-amber-500 rounded-full flex items-center justify-center font-bold flex-shrink-0">4</div><p>Setup MUST follow attached TGS — contact supervisor for any changes</p></div></div></div>',
    layout: 'content',
    icon: '📜'
  },
  {
    title: 'Prestart Toolbox Talk',
    subtitle: 'Mandatory before each shift',
    content: '<div class="grid md:grid-cols-2 gap-4"><div class="bg-white/10 rounded-xl p-5"><p class="font-bold text-lg mb-2">🎯 Site Hazards</p><p class="text-amber-200">Identify potential dangers — speeding vehicles, weather, road conditions</p></div><div class="bg-white/10 rounded-xl p-5"><p class="font-bold text-lg mb-2">🗺️ Traffic Management</p><p class="text-amber-200">Review site layout, signage, and flow of vehicles</p></div><div class="bg-white/10 rounded-xl p-5"><p class="font-bold text-lg mb-2">👷 Roles & Duties</p><p class="text-amber-200">Clarify duties for TCs, spotters, and supervisors</p></div><div class="bg-white/10 rounded-xl p-5"><p class="font-bold text-lg mb-2">🚨 Emergency Plan</p><p class="text-amber-200">Emergency contacts, first aid, evacuation points</p></div><div class="bg-white/10 rounded-xl p-5"><p class="font-bold text-lg mb-2">📻 Communication</p><p class="text-amber-200">Agree on hand signals, radios, and tools</p></div><div class="bg-white/10 rounded-xl p-5"><p class="font-bold text-lg mb-2">🌦️ Weather</p><p class="text-amber-200">Plan for rain, heat, wind, or low visibility</p></div></div>',
    layout: 'split',
    icon: '🔧'
  },
  {
    title: 'Safety Measures — Toolbox',
    subtitle: 'Must discuss every shift',
    content: '<div class="max-w-3xl mx-auto space-y-3"><div class="bg-white/10 rounded-xl p-4 flex items-start gap-3"><span class="text-xl">🚶</span><p><strong>Pedestrian Routes</strong> must include ramps and be fully accessible to people with disabilities</p></div><div class="bg-white/10 rounded-xl p-4 flex items-start gap-3"><span class="text-xl">⚠️</span><p><strong>Ground Openings</strong> and Work Zones must be fully closed off using cones and tiger tails</p></div><div class="bg-red-500/20 border border-red-500/40 rounded-xl p-4 flex items-start gap-3"><span class="text-xl">🚜</span><p><strong>Machinery Operations</strong> — No person within <strong>5-metre radius</strong> of any truck or machinery. Must have designated spotter.</p></div><div class="bg-white/10 rounded-xl p-4 flex items-start gap-3"><span class="text-xl">🪧</span><p><strong>Traffic Signage</strong> must follow Australian Standards (AS) with proper spacing</p></div><div class="bg-white/10 rounded-xl p-4 flex items-start gap-3"><span class="text-xl">🚪</span><p><strong>Emergency Planning</strong> — Confirm clear escape routes for all TC positions</p></div></div>',
    layout: 'list',
    icon: '🔒'
  },
  {
    title: 'Shift Timeline',
    subtitle: 'A typical day on site',
    content: '<div class="max-w-4xl mx-auto"><div class="flex flex-wrap justify-center gap-2"><div class="bg-blue-500/30 rounded-lg px-4 py-3 text-center"><p class="text-xs text-blue-300">06:45</p><p class="text-sm font-bold">Drive</p></div><div class="text-2xl text-amber-400">→</div><div class="bg-blue-500/30 rounded-lg px-4 py-3 text-center"><p class="text-xs text-blue-300">07:00</p><p class="text-sm font-bold">Toolbox</p></div><div class="text-2xl text-amber-400">→</div><div class="bg-green-500/30 rounded-lg px-4 py-3 text-center"><p class="text-xs text-green-300">07:15</p><p class="text-sm font-bold">Set Up</p></div><div class="text-2xl text-amber-400">→</div><div class="bg-green-500/30 rounded-lg px-4 py-3 text-center"><p class="text-xs text-green-300">09:00</p><p class="text-sm font-bold">Rotate</p></div><div class="text-2xl text-amber-400">→</div><div class="bg-amber-500/30 rounded-lg px-4 py-3 text-center"><p class="text-xs text-amber-300">12:00</p><p class="text-sm font-bold">Lunch</p></div><div class="text-2xl text-amber-400">→</div><div class="bg-green-500/30 rounded-lg px-4 py-3 text-center"><p class="text-xs text-green-300">13:00</p><p class="text-sm font-bold">Check Signs</p></div><div class="text-2xl text-amber-400">→</div><div class="bg-red-500/30 rounded-lg px-4 py-3 text-center"><p class="text-xs text-red-300">15:30</p><p class="text-sm font-bold">Pack Up</p></div><div class="text-2xl text-amber-400">→</div><div class="bg-blue-500/30 rounded-lg px-4 py-3 text-center"><p class="text-xs text-blue-300">16:00</p><p class="text-sm font-bold">Timesheet</p></div></div><p class="text-center text-lg text-amber-300 mt-6 font-bold">YOUR SAFETY, IN OUR SIGHTS</p></div>',
    layout: 'content',
    icon: '⏰'
  },
  {
    title: 'Setting Up — Step 1',
    subtitle: 'Assess the Site',
    content: '<div class="max-w-3xl mx-auto"><div class="bg-amber-500/20 border border-amber-500/40 rounded-xl p-6 mb-6 text-center"><p class="text-xl font-bold text-amber-300">"Stop before you set up."</p></div><div class="bg-white/10 rounded-xl p-6"><p class="font-bold text-lg mb-4">Checklist:</p><ul class="space-y-3 text-lg"><li class="flex items-start gap-3"><span class="text-green-400">✓</span> Check road speed, lanes, gradients, and visibility</li><li class="flex items-start gap-3"><span class="text-green-400">✓</span> Identify hazards: blind corners, driveways, heavy traffic, weather</li><li class="flex items-start gap-3"><span class="text-green-400">✓</span> Confirm the TMP/TGS matches actual conditions</li><li class="flex items-start gap-3"><span class="text-green-400">✓</span> Ensure all PPE and equipment are available</li><li class="flex items-start gap-3"><span class="text-green-400">✓</span> Communicate hazards in the toolbox talk</li></ul><p class="mt-4 text-red-300 font-semibold">If site conditions differ from the plan — STOP and call the Team Leader.</p></div></div>',
    layout: 'content',
    icon: '👁️'
  },
  {
    title: 'Setting Up — Step 2',
    subtitle: 'Place Advance Warning Signs',
    content: '<div class="max-w-3xl mx-auto"><div class="bg-amber-500/20 border border-amber-500/40 rounded-xl p-6 mb-6 text-center"><p class="text-xl font-bold text-amber-300">"Warn before you work."</p></div><div class="bg-white/10 rounded-xl p-6 mb-4"><p class="font-bold text-lg mb-3">Spacing by Speed:</p><div class="grid grid-cols-3 gap-3 text-center"><div class="bg-green-500/20 rounded-lg p-3"><p class="font-bold">40 km/h</p><p class="text-sm text-amber-200">40m spacing</p></div><div class="bg-amber-500/20 rounded-lg p-3"><p class="font-bold">60 km/h</p><p class="text-sm text-amber-200">80m spacing</p></div><div class="bg-red-500/20 rounded-lg p-3"><p class="font-bold">80+ km/h</p><p class="text-sm text-amber-200">Shadow vehicle required</p></div></div></div><div class="bg-white/10 rounded-xl p-6"><p class="font-bold mb-3">Install signs:</p><ul class="space-y-2"><li>🪧 "Roadwork Ahead", "Digger Man", "Prepare to Stop", "TC Ahead"</li><li>📐 Signs face traffic direction — clean, upright, and secure</li><li>♿ No sign blocks pedestrian paths or private driveways</li></ul></div></div>',
    layout: 'content',
    icon: '🪧'
  },
  {
    title: 'Setting Up — Step 3',
    subtitle: 'Install Traffic Control Devices',
    content: '<div class="max-w-3xl mx-auto"><div class="bg-amber-500/20 border border-amber-500/40 rounded-xl p-6 mb-6 text-center"><p class="text-xl font-bold text-amber-300">"Guide traffic safely through or around the site."</p></div><div class="bg-white/10 rounded-xl p-6"><ul class="space-y-4 text-lg"><li class="flex items-start gap-3"><span class="text-amber-400">▸</span> Place cones and barriers <strong>in traffic direction</strong></li><li class="flex items-start gap-3"><span class="text-amber-400">▸</span> Keep cones <strong>evenly spaced</strong> per speed limit</li><li class="flex items-start gap-3"><span class="text-amber-400">▸</span> Use bollards or barriers for pedestrians</li><li class="flex items-start gap-3"><span class="text-amber-400">▸</span> Set up Stop/Slow bats or PTCDs (portable lights/gates)</li><li class="flex items-start gap-3"><span class="text-amber-400">▸</span> Confirm lane tapers, buffers, and spacing against the TGS</li></ul></div></div>',
    layout: 'content',
    icon: '🚧'
  },
  {
    title: 'Setting Up — Step 4',
    subtitle: 'Establish Safe Work Zones',
    content: '<div class="max-w-3xl mx-auto"><div class="bg-red-500/20 border border-red-500/40 rounded-xl p-6 mb-6 text-center"><p class="text-xl font-bold text-red-300">"Protect your people first."</p></div><div class="bg-white/10 rounded-xl p-6"><ul class="space-y-4 text-lg"><li class="flex items-start gap-3"><span class="text-red-400">●</span> Mark <strong>buffer zones</strong> (safety space in front of work crew)</li><li class="flex items-start gap-3"><span class="text-red-400">●</span> Create <strong>exclusion zones</strong> around plant and machinery</li><li class="flex items-start gap-3"><span class="text-red-400">●</span> Keep at least <strong>5m distance</strong> from operating trucks or excavators</li><li class="flex items-start gap-3"><span class="text-red-400">●</span> Confirm <strong>escape routes</strong> are known and clear</li><li class="flex items-start gap-3"><span class="text-red-400">●</span> <strong>No unauthorised entry</strong> into exclusion zones</li></ul></div></div>',
    layout: 'content',
    icon: '🛑'
  },
  {
    title: 'Setting Up — Step 5',
    subtitle: 'Inspect, Test & Monitor',
    content: '<div class="max-w-3xl mx-auto"><div class="bg-green-500/20 border border-green-500/40 rounded-xl p-6 mb-6 text-center"><p class="text-xl font-bold text-green-300">"Check it before you start it."</p></div><div class="bg-white/10 rounded-xl p-6"><ul class="space-y-4 text-lg"><li class="flex items-start gap-3"><span class="text-green-400">✓</span> Walk the full site — check visibility, cone alignment, sign order</li><li class="flex items-start gap-3"><span class="text-green-400">✓</span> Adjust any crooked, missing, or obstructed devices</li><li class="flex items-start gap-3"><span class="text-green-400">✓</span> Team Leader completes and submits the <strong>TLC in Traffio</strong></li><li class="flex items-start gap-3"><span class="text-green-400">✓</span> Review setup <strong>mid-shift</strong> and after any weather or traffic change</li><li class="flex items-start gap-3"><span class="text-green-400">✓</span> Keep <strong>photos</strong> for records and audits</li></ul></div></div>',
    layout: 'content',
    icon: '🔍'
  },
  {
    title: 'Team Leader Checklists (TLC)',
    subtitle: 'Critical for compliance',
    content: '<div class="max-w-3xl mx-auto"><div class="bg-white/10 rounded-xl p-6 space-y-4"><p class="text-lg">TLCs are submitted on <strong>Traffio</strong> and are essential for:</p><ul class="space-y-3 text-lg"><li class="flex items-start gap-3"><span class="text-amber-400">▸</span> Ensuring site setup is completed correctly and documented early</li><li class="flex items-start gap-3"><span class="text-amber-400">▸</span> Providing evidence for client requirements and safety audits</li><li class="flex items-start gap-3"><span class="text-amber-400">▸</span> Must clearly show adequate traffic and pedestrian signage</li><li class="flex items-start gap-3"><span class="text-amber-400">▸</span> All TCs must be wearing full PPE in photos</li></ul></div><div class="bg-red-500/20 border border-red-500/40 rounded-xl p-5 mt-6"><p class="font-bold text-red-300">⚠️ In the event of an incident, TLCs will be reviewed by SafeWork NSW.</p><p class="text-amber-200 mt-1">If the checklist does not comply with Australian Standards (AS), the Team Leader may face fines.</p></div></div>',
    layout: 'content',
    icon: '📋'
  },
  {
    title: 'Breaks',
    subtitle: 'Mandatory rest schedule',
    content: '<div class="max-w-3xl mx-auto"><div class="grid md:grid-cols-3 gap-4 mb-6"><div class="bg-white/10 rounded-xl p-5 text-center"><p class="text-3xl font-bold text-amber-400">2 hrs</p><p class="font-semibold mt-1">On the bat</p><p class="text-sm text-amber-200">Min. 15-min rest break</p></div><div class="bg-white/10 rounded-xl p-5 text-center"><p class="text-3xl font-bold text-amber-400">5 hrs</p><p class="font-semibold mt-1">On shift</p><p class="text-sm text-amber-200">Min. 30-min meal break</p></div><div class="bg-white/10 rounded-xl p-5 text-center"><p class="text-3xl font-bold text-red-400">12 hrs</p><p class="font-semibold mt-1">Maximum</p><p class="text-sm text-amber-200">Including all breaks</p></div></div><div class="bg-white/10 rounded-xl p-5 mb-4"><p class="font-bold mb-2">Managing Breaks:</p><ul class="space-y-2 text-amber-200"><li>• Stagger breaks — one TC at a time</li><li>• Use relief controllers to cover</li><li>• Rotate between high and low intensity positions</li><li>• Increase breaks in extreme weather</li></ul></div><div class="bg-red-500/20 border border-red-500/40 rounded-xl p-4 text-center"><p class="font-bold text-red-300">NO EATING OR RESTING IN THE UTE WHILST ON SHIFT!</p></div></div>',
    layout: 'content',
    icon: '☕'
  },
  {
    title: 'End of Shift',
    subtitle: 'Packing up safely',
    content: '<div class="max-w-3xl mx-auto space-y-4"><div class="bg-white/10 rounded-xl p-5"><p class="font-bold text-lg mb-2">1. Remove in Reverse Order</p><ul class="space-y-1 text-amber-200"><li>• Start from the termination area first</li><li>• Progressively remove cones, barriers, signs</li><li>• Signs removed LAST — do not remove early</li><li>• Always face oncoming traffic when working near road</li></ul></div><div class="bg-white/10 rounded-xl p-5"><p class="font-bold text-lg mb-2">2. Vehicle Manoeuvring</p><ul class="space-y-1 text-amber-200"><li>• Park vehicle in safe, visible location</li><li>• Use a spotter when reversing or merging</li><li>• Warning lights, beacons, hazard signals ON</li></ul></div><div class="bg-white/10 rounded-xl p-5"><p class="font-bold text-lg mb-2">3. Final Check</p><ul class="space-y-1 text-amber-200"><li>• Walk through — confirm all equipment packed</li><li>• Road returned to normal conditions</li><li>• Communicate to team that site is fully cleared</li></ul></div></div>',
    layout: 'list',
    icon: '🏁'
  },
  {
    title: 'Safety in Traffic Control',
    subtitle: 'The foundation of everything we do',
    content: '<div class="text-center max-w-2xl mx-auto"><p class="text-2xl leading-relaxed mb-8">Safety is the foundation of effective traffic control.</p><p class="text-xl text-amber-200 mb-8">Our goal: <strong>protect our team, the public, and our clients.</strong></p><div class="bg-white/10 rounded-2xl p-8"><p class="text-lg">This section outlines our policies, responsibilities, and procedures to ensure <strong>incident-free worksites.</strong></p></div></div>',
    layout: 'highlight',
    icon: '🛡️'
  },
  {
    title: 'Team-Based Safety Culture',
    subtitle: 'We work for each other',
    content: '<div class="max-w-3xl mx-auto"><div class="space-y-4"><div class="bg-white/10 rounded-xl p-6 flex items-start gap-4"><span class="text-3xl">🤝</span><div><p class="font-bold text-lg">Do your checks — for the whole team</p><p class="text-amber-200">Not just for yourself, but to protect everyone around you.</p></div></div><div class="bg-white/10 rounded-xl p-6 flex items-start gap-4"><span class="text-3xl">📢</span><div><p class="font-bold text-lg">Speak up if something looks unsafe</p><p class="text-amber-200">Your voice could prevent an accident or save a life.</p></div></div><div class="bg-white/10 rounded-xl p-6 flex items-start gap-4"><span class="text-3xl">🎓</span><div><p class="font-bold text-lg">Help new workers understand the ropes</p><p class="text-amber-200">Your guidance could prevent an accident.</p></div></div></div><div class="bg-amber-500/20 border border-amber-500/40 rounded-xl p-5 mt-6 text-center"><p class="text-lg font-bold">No shortcuts — everyone deserves to go home safe.</p></div></div>',
    layout: 'content',
    icon: '👥'
  },
  {
    title: 'Adverse Weather',
    subtitle: 'Adjust for conditions',
    content: '<div class="grid grid-cols-2 gap-6 max-w-3xl mx-auto"><div class="bg-blue-500/20 border border-blue-500/40 rounded-xl p-6 text-center"><p class="text-4xl mb-3">🌧️</p><p class="font-bold text-lg">Rain</p><p class="text-amber-200">Slow speed zones, extra visibility measures</p></div><div class="bg-red-500/20 border border-red-500/40 rounded-xl p-6 text-center"><p class="text-4xl mb-3">🔥</p><p class="font-bold text-lg">Heat</p><p class="text-amber-200">Breathable PPE, hydrate often</p></div><div class="bg-gray-500/20 border border-gray-500/40 rounded-xl p-6 text-center"><p class="text-4xl mb-3">💨</p><p class="font-bold text-lg">Wind</p><p class="text-amber-200">Secure signage and barriers</p></div><div class="bg-purple-500/20 border border-purple-500/40 rounded-xl p-6 text-center"><p class="text-4xl mb-3">🌑</p><p class="font-bold text-lg">Low Light</p><p class="text-amber-200">Reflective gear and adequate lighting</p></div></div>',
    layout: 'split',
    icon: '🌦️'
  },
  {
    title: 'Communication Protocols',
    subtitle: 'Clear communication saves lives',
    content: '<div class="max-w-3xl mx-auto space-y-4"><div class="bg-white/10 rounded-xl p-5 flex items-start gap-4"><span class="text-2xl">📻</span><p class="text-lg">Use radios correctly and keep communication <strong>clear and concise</strong></p></div><div class="bg-white/10 rounded-xl p-5 flex items-start gap-4"><span class="text-2xl">✋</span><p class="text-lg">Follow <strong>hand signal protocols</strong> when directing traffic or vehicles</p></div><div class="bg-white/10 rounded-xl p-5 flex items-start gap-4"><span class="text-2xl">✅</span><p class="text-lg">Always <strong>confirm instructions</strong> — don\'t assume</p></div><div class="bg-white/10 rounded-xl p-5 flex items-start gap-4"><span class="text-2xl">⬆️</span><p class="text-lg"><strong>Escalate issues</strong> to the team leader promptly</p></div></div>',
    layout: 'list',
    icon: '📻'
  },
  {
    title: 'Emergency Response',
    subtitle: 'Be prepared at all times',
    content: '<div class="max-w-3xl mx-auto"><div class="grid md:grid-cols-3 gap-6"><div class="bg-red-500/20 border border-red-500/40 rounded-xl p-6 text-center"><p class="text-4xl mb-3">🚪</p><p class="font-bold text-lg mb-2">Know Your Exits</p><p class="text-amber-200">Emergency exits, first aid locations, assembly points</p></div><div class="bg-amber-500/20 border border-amber-500/40 rounded-xl p-6 text-center"><p class="text-4xl mb-3">😌</p><p class="font-bold text-lg mb-2">Stay Calm</p><p class="text-amber-200">Alert your team and call for help immediately</p></div><div class="bg-green-500/20 border border-green-500/40 rounded-xl p-6 text-center"><p class="text-4xl mb-3">📝</p><p class="font-bold text-lg mb-2">Report Everything</p><p class="text-amber-200">All incidents must be reported, no matter how small</p></div></div></div>',
    layout: 'split',
    icon: '🚨'
  },
  {
    title: 'Incident & Near-Miss Reporting',
    subtitle: 'Honest reporting prevents future accidents',
    content: '<div class="max-w-3xl mx-auto"><div class="bg-white/10 rounded-xl p-6 space-y-4"><div class="flex items-start gap-4"><div class="w-10 h-10 bg-red-500 rounded-full flex items-center justify-center font-bold flex-shrink-0">1</div><p class="text-lg">Report injuries, near misses, and unsafe behaviour <strong>immediately</strong></p></div><div class="flex items-start gap-4"><div class="w-10 h-10 bg-amber-500 rounded-full flex items-center justify-center font-bold flex-shrink-0">2</div><p class="text-lg">Complete the incident report form <strong>as soon as possible</strong></p></div><div class="flex items-start gap-4"><div class="w-10 h-10 bg-green-500 rounded-full flex items-center justify-center font-bold flex-shrink-0">3</div><p class="text-lg">Honest reporting helps <strong>prevent future accidents</strong></p></div><div class="flex items-start gap-4"><div class="w-10 h-10 bg-blue-500 rounded-full flex items-center justify-center font-bold flex-shrink-0">4</div><p class="text-lg">Follow-up actions will be taken <strong>seriously</strong></p></div></div></div>',
    layout: 'content',
    icon: '📋'
  },
  {
    title: 'What To Do In These Situations',
    subtitle: 'Quick response guide',
    content: '<div class="max-w-3xl mx-auto space-y-3"><div class="bg-red-500/20 rounded-xl p-4 flex items-start gap-4"><span class="font-bold text-red-300 w-52 flex-shrink-0">Driver ignores STOP bat</span><p class="text-amber-200">Move to safety, radio supervisor immediately</p></div><div class="bg-amber-500/20 rounded-xl p-4 flex items-start gap-4"><span class="font-bold text-amber-300 w-52 flex-shrink-0">You feel dizzy or faint</span><p class="text-amber-200">Notify buddy/supervisor, leave post safely</p></div><div class="bg-white/10 rounded-xl p-4 flex items-start gap-4"><span class="font-bold w-52 flex-shrink-0">Public in your work zone</span><p class="text-amber-200">Politely stop them, guide away, call for backup if needed</p></div><div class="bg-white/10 rounded-xl p-4 flex items-start gap-4"><span class="font-bold w-52 flex-shrink-0">Aggressive driver/person</span><p class="text-amber-200">Don\'t engage, step back, call supervisor</p></div><div class="bg-white/10 rounded-xl p-4 flex items-start gap-4"><span class="font-bold w-52 flex-shrink-0">Co-worker sleeping on post</span><p class="text-amber-200">Tell supervisor privately</p></div></div>',
    layout: 'list',
    icon: '🆘'
  },
  {
    title: 'Stop/Slow Bat',
    subtitle: 'Your primary tool',
    content: '<div class="max-w-3xl mx-auto"><div class="grid md:grid-cols-2 gap-6"><div class="bg-white/10 rounded-xl p-6"><p class="text-lg mb-4">Your stop/slow bat is your <strong>primary tool</strong> as a Traffic Controller.</p><ul class="space-y-3"><li class="flex items-start gap-2"><span class="text-amber-400">▸</span> Must be extended to minimum <strong>1.8 metres</strong></li><li class="flex items-start gap-2"><span class="text-amber-400">▸</span> Twist and pull to extend, twist and push to shorten</li><li class="flex items-start gap-2"><span class="text-amber-400">▸</span> Ensure clearly visible to oncoming traffic</li></ul></div><div class="bg-red-500/20 border border-red-500/40 rounded-xl p-6"><p class="font-bold text-red-300 mb-3">Handle With Care!</p><ul class="space-y-2 text-amber-200"><li>🚫 Do NOT lean on the bat</li><li>🚫 Do NOT leave it unattended</li><li>🔒 Store neatly in the Ute and lock up</li><li>💰 Replacement cost: <strong>$120</strong></li></ul></div></div></div>',
    layout: 'split',
    icon: '🛑'
  },
  {
    title: 'Tiger Tails',
    subtitle: 'Closing off exclusion zones',
    content: '<div class="max-w-2xl mx-auto text-center"><div class="bg-white/10 rounded-2xl p-8 mb-6"><p class="text-xl mb-6">All exclusion zones must be <strong>fully closed off</strong> using tiger tails.</p><div class="grid grid-cols-2 gap-4"><div class="bg-red-500/20 rounded-xl p-4"><p class="font-bold">🚫 Don\'t throw</p></div><div class="bg-red-500/20 rounded-xl p-4"><p class="font-bold">🚫 Don\'t bend</p></div><div class="bg-red-500/20 rounded-xl p-4"><p class="font-bold">🚫 Don\'t lean on</p></div><div class="bg-red-500/20 rounded-xl p-4"><p class="font-bold">🚫 Never leave behind</p></div></div></div><div class="bg-amber-500/20 border border-amber-500/40 rounded-xl p-5"><p class="text-lg">Made of plastic — <strong>extremely brittle.</strong> Each costs <strong>$25</strong> to replace.</p></div></div>',
    layout: 'highlight',
    icon: '🐯'
  },
  {
    title: 'Pedestrian Management',
    subtitle: 'Protecting the public',
    content: '<div class="max-w-3xl mx-auto space-y-3"><div class="bg-white/10 rounded-xl p-4 flex items-start gap-3"><span class="text-xl">🚶</span><p>Always maintain a <strong>safe, clearly marked path</strong> for pedestrians</p></div><div class="bg-white/10 rounded-xl p-4 flex items-start gap-3"><span class="text-xl">🪧</span><p>Ensure <strong>signage is visible</strong> and facing the correct direction</p></div><div class="bg-white/10 rounded-xl p-4 flex items-start gap-3"><span class="text-xl">🔶</span><p>Use <strong>bollards, cones, and barriers</strong> to prevent access into work zones</p></div><div class="bg-white/10 rounded-xl p-4 flex items-start gap-3"><span class="text-xl">♿</span><p>Assist <strong>vulnerable pedestrians</strong> (elderly, disabled, parents with prams)</p></div><div class="bg-white/10 rounded-xl p-4 flex items-start gap-3"><span class="text-xl">🚪</span><p>Never block access to <strong>entryways or driveways</strong> unless approved</p></div><div class="bg-white/10 rounded-xl p-4 flex items-start gap-3"><span class="text-xl">👀</span><p>If heavy traffic or poor visibility — <strong>use a spotter or second TC</strong></p></div></div>',
    layout: 'list',
    icon: '🚶'
  },
  {
    title: 'Stop/Slow Operations',
    subtitle: 'Manual traffic control',
    content: '<div class="max-w-3xl mx-auto"><div class="bg-white/10 rounded-xl p-6"><ul class="space-y-4 text-lg"><li class="flex items-start gap-3"><span class="text-amber-400">▸</span> Manual method used when <strong>one lane is closed</strong></li><li class="flex items-start gap-3"><span class="text-amber-400">▸</span> One controller stops traffic from one direction while the other allows traffic to <strong>slowly pass</strong></li><li class="flex items-start gap-3"><span class="text-amber-400">▸</span> Controllers must <strong>coordinate using radios</strong></li><li class="flex items-start gap-3"><span class="text-amber-400">▸</span> Ensures safe, <strong>alternating flow</strong> of vehicles through narrow areas</li></ul></div></div>',
    layout: 'content',
    icon: '🔄'
  },
  {
    title: 'Lane Merger & Taper',
    subtitle: 'Reducing lanes safely',
    content: '<div class="max-w-3xl mx-auto"><div class="bg-white/10 rounded-xl p-6 mb-4"><ul class="space-y-3 text-lg"><li class="flex items-start gap-3"><span class="text-amber-400">▸</span> Two or more lanes reduce into a single lane near roadworks</li><li class="flex items-start gap-3"><span class="text-amber-400">▸</span> Requires clear <strong>merging signs and chevrons</strong></li><li class="flex items-start gap-3"><span class="text-amber-400">▸</span> Drivers must merge safely and early</li><li class="flex items-start gap-3"><span class="text-amber-400">▸</span> Must have <strong>warning Lane-Stat Signs</strong></li><li class="flex items-start gap-3"><span class="text-amber-400">▸</span> TCs may assist if visibility or volume is high</li></ul></div></div>',
    layout: 'content',
    icon: '↗️'
  },
  {
    title: 'Site Entry/Exit',
    subtitle: 'Safe vehicle access procedures',
    content: '<div class="max-w-3xl mx-auto"><div class="bg-white/10 rounded-xl p-6 space-y-4"><div class="flex items-start gap-4"><div class="w-8 h-8 bg-amber-500 rounded-full flex items-center justify-center font-bold flex-shrink-0">1</div><p class="text-lg">Highlight entry with <strong>double cones</strong> and small break to pull in safely</p></div><div class="flex items-start gap-4"><div class="w-8 h-8 bg-amber-500 rounded-full flex items-center justify-center font-bold flex-shrink-0">2</div><p class="text-lg">Turn on <strong>flashing lights</strong> before entering</p></div><div class="flex items-start gap-4"><div class="w-8 h-8 bg-amber-500 rounded-full flex items-center justify-center font-bold flex-shrink-0">3</div><p class="text-lg"><strong>Radio the TC</strong> minimum 100m prior</p></div><div class="flex items-start gap-4"><div class="w-8 h-8 bg-red-500 rounded-full flex items-center justify-center font-bold flex-shrink-0">!</div><p class="text-lg text-red-300">If missed — TC directs vehicle to <strong>loop around</strong> and attempt re-entry</p></div><div class="flex items-start gap-4"><div class="w-8 h-8 bg-red-500 rounded-full flex items-center justify-center font-bold flex-shrink-0">!</div><p class="text-lg text-red-300">Ensure <strong>no local traffic follows</strong> work vehicles into the work area</p></div></div></div>',
    layout: 'content',
    icon: '🚪'
  },
  {
    title: 'Speed Reduction',
    subtitle: 'Work zone speed limits',
    content: '<div class="max-w-3xl mx-auto space-y-4"><div class="bg-white/10 rounded-xl p-5 flex items-start gap-3"><span class="text-xl">🏎️</span><p class="text-lg">Always observe posted speed limits in and around work zones</p></div><div class="bg-white/10 rounded-xl p-5 flex items-start gap-3"><span class="text-xl">⬇️</span><p class="text-lg">Reduce speed well before entering the site</p></div><div class="bg-white/10 rounded-xl p-5 flex items-start gap-3"><span class="text-xl">🪧</span><p class="text-lg">Follow all signage and TC instructions</p></div><div class="bg-amber-500/20 border border-amber-500/40 rounded-xl p-5 text-center"><p class="text-xl font-bold text-amber-300">Never exceed 40 km/h in active work zones unless signed otherwise</p></div><div class="bg-white/10 rounded-xl p-5 flex items-start gap-3"><span class="text-xl">🚗</span><p class="text-lg">Maintain safe distance from vehicles and pedestrians</p></div></div>',
    layout: 'list',
    icon: '🐌'
  },
  {
    title: 'Road Closure',
    subtitle: 'Full closure requirements',
    content: '<div class="max-w-3xl mx-auto text-center"><div class="bg-red-500/20 border border-red-500/40 rounded-2xl p-8 mb-6"><p class="text-4xl mb-4">🚫</p><p class="text-2xl font-bold text-red-300">Road Closures</p></div><div class="grid md:grid-cols-2 gap-6"><div class="bg-white/10 rounded-xl p-6"><p class="text-4xl mb-3">🪧</p><p class="font-bold text-lg mb-2">Warning Signs</p><p class="text-amber-200">Must have warning signs from <strong>ALL directions</strong> coming towards the closure</p></div><div class="bg-white/10 rounded-xl p-6"><p class="text-4xl mb-3">🔀</p><p class="font-bold text-lg mb-2">Detour Route</p><p class="text-amber-200">ALL road closures must have a clearly signed <strong>detour route</strong></p></div></div></div>',
    layout: 'highlight',
    icon: '🚫'
  },
  {
    title: 'Key Definitions',
    subtitle: 'Know your terminology',
    content: '<div class="max-w-3xl mx-auto grid grid-cols-2 gap-3 text-sm"><div class="bg-white/10 rounded-lg p-3"><p class="font-bold text-amber-400">ROL</p><p class="text-amber-200">Road Occupancy Licence — permit to use road space</p></div><div class="bg-white/10 rounded-lg p-3"><p class="font-bold text-amber-400">SWMS</p><p class="text-amber-200">Safe Work Method Statement — legal document for high-risk work</p></div><div class="bg-white/10 rounded-lg p-3"><p class="font-bold text-amber-400">TGS / TCP</p><p class="text-amber-200">Traffic Guidance Scheme / Traffic Control Plan</p></div><div class="bg-white/10 rounded-lg p-3"><p class="font-bold text-amber-400">TMP</p><p class="text-amber-200">Traffic Management Plan — detailed planning report</p></div><div class="bg-white/10 rounded-lg p-3"><p class="font-bold text-amber-400">PTCD</p><p class="text-amber-200">Portable Traffic Control Device (VMS, boom gates, lights)</p></div><div class="bg-white/10 rounded-lg p-3"><p class="font-bold text-amber-400">TMA</p><p class="text-amber-200">Truck Mounted Attenuator — rear safety device</p></div><div class="bg-white/10 rounded-lg p-3"><p class="font-bold text-amber-400">VMS</p><p class="text-amber-200">Variable Message Signs — electronic programmable signs</p></div><div class="bg-white/10 rounded-lg p-3"><p class="font-bold text-amber-400">Dimension D</p><p class="text-amber-200">Road speed in metres — determines device placement</p></div></div>',
    layout: 'split',
    icon: '📖'
  },
];

module.exports = { employeeGuideSlides, tcTrainingSlides };
