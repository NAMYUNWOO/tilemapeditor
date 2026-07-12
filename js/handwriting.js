// 손글씨 패드 + 인식.
// Apple Pencil(및 손가락/마우스)로 쓴 잉크 스트로크를 Google Input Tools 손글씨 API로 인식한다.
// (인식 실패/오프라인 시 텍스트 입력 폴백 — iPadOS에서는 텍스트 입력창에 펜슬로 쓰면
//  OS의 Scribble이 자동으로 텍스트로 변환해 준다.)
export class HandwritingPad {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.strokes = [];   // [{x:[], y:[], t:[]}]
    this.current = null;
    this.startTime = 0;

    canvas.addEventListener('pointerdown', e => {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      if (!this.strokes.length) this.startTime = performance.now();
      this.current = { x: [e.offsetX], y: [e.offsetY], t: [Math.round(performance.now() - this.startTime)] };
    });
    canvas.addEventListener('pointermove', e => {
      if (!this.current) return;
      // getCoalescedEvents로 펜슬 고빈도 샘플 활용
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of events) {
        this.current.x.push(ev.offsetX);
        this.current.y.push(ev.offsetY);
        this.current.t.push(Math.round(performance.now() - this.startTime));
      }
      this.draw();
    });
    const end = () => {
      if (!this.current) return;
      this.strokes.push(this.current);
      this.current = null;
      this.draw();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    this.resize();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.draw();
  }

  clear() {
    this.strokes = [];
    this.current = null;
    this.draw();
  }

  isEmpty() { return !this.strokes.length && !this.current; }

  draw() {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // 가이드 라인
    const h = this.canvas.height / dpr, w = this.canvas.width / dpr;
    ctx.strokeStyle = '#dfe3ee';
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(10, h * 0.75); ctx.lineTo(w - 10, h * 0.75);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = '#1a1a22';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of [...this.strokes, this.current]) {
      if (!s || !s.x.length) continue;
      ctx.beginPath();
      ctx.moveTo(s.x[0], s.y[0]);
      for (let i = 1; i < s.x.length; i++) ctx.lineTo(s.x[i], s.y[i]);
      ctx.stroke();
    }
  }

  // 인식 결과 후보 문자열 배열 반환
  async recognize(lang = 'ko') {
    if (!this.strokes.length) return [];
    const r = this.canvas.getBoundingClientRect();
    const body = {
      options: 'enable_pre_space',
      requests: [{
        writing_guide: { writing_area_width: Math.round(r.width), writing_area_height: Math.round(r.height) },
        ink: this.strokes.map(s => [s.x, s.y, s.t]),
        language: lang,
      }],
    };
    const url = `https://inputtools.google.com/request?itc=${lang}-t-i0-handwrit&app=tilemapeditor`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('recognition http ' + res.status);
    const data = await res.json();
    if (data[0] !== 'SUCCESS') throw new Error('recognition failed: ' + data[0]);
    return (data[1]?.[0]?.[1] || []).map(s => String(s).trim()).filter(Boolean);
  }
}
