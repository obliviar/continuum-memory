/** Small hand-labelled diagnostic set; not a representative accuracy benchmark. */
export const localOpenExtractionCases = [
  { id: 'storage', category: 'known', text: '样品S7存放在恒温箱B2。', gold: [{ relation: '存放在', participants: ['样品S7', '恒温箱B2'] }] },
  { id: 'dependency', category: 'known', text: '模块A依赖于模块B。', gold: [{ relation: '依赖于', participants: ['模块A', '模块B'] }] },
  { id: 'placement', category: 'known', text: '小王把样品S7放入冷柜C。', gold: [{ relation: '放入', participants: ['小王', '样品S7', '冷柜C'] }] },
  { id: 'crystal', category: 'unfamiliar', text: '晶体A外延生长于衬底B。', gold: [{ relation: '外延生长于', participants: ['晶体A', '衬底B'] }] },
  { id: 'catalysis', category: 'unfamiliar', text: '酶E催化底物S的水解。', gold: [{ relation: '催化', participants: ['酶E', '底物S的水解'] }] },
  { id: 'outage', category: 'state', text: '今天宿舍空调坏了。', gold: [{ relation: '坏了', participants: ['宿舍空调'] }] },
  { id: 'opinion', category: 'opinion', text: 'deepseek大模型的功能是最强的。', gold: [{ relation: '是', participants: ['deepseek大模型的功能', '最强的'] }] },
  { id: 'transfer', category: 'multiple', text: '小王把样品交给小李，小李把样品放入冷柜。', gold: [
    { relation: '交给', participants: ['小王', '样品', '小李'] }, { relation: '放入', participants: ['小李', '样品', '冷柜'] }] },
  { id: 'parallel', category: 'multiple', text: '小王负责项目A，小李负责项目B。', gold: [
    { relation: '负责', participants: ['小王', '项目A'] }, { relation: '负责', participants: ['小李', '项目B'] }] },
  { id: 'negative', category: 'context', text: '样品S7不存放在恒温箱B2。', gold: [{ relation: '存放在', participants: ['样品S7', '恒温箱B2'] }] },
  { id: 'conditional', category: 'context', text: '如果设备修好，样品S7存放在恒温箱B2。', gold: [{ relation: '存放在', participants: ['样品S7', '恒温箱B2'] }] },
  { id: 'reported', category: 'context', text: '小王说样品S7存放在恒温箱B2。', gold: [{ relation: '存放在', participants: ['样品S7', '恒温箱B2'] }] },
  { id: 'preference', category: 'ordinary', text: '我喜欢喝牛奶巧克力。', gold: [{ relation: '喜欢', participants: ['我', '喝牛奶巧克力'] }] },
  { id: 'explicit', category: 'explicit', text: '晶体A与衬底B的关系是外延生长于。', gold: [{ relation: '外延生长于', participants: ['晶体A', '衬底B'] }] },
  { id: 'unicode', category: 'unicode', text: '🧪样品S7存放在恒温箱B2。', gold: [{ relation: '存放在', participants: ['🧪样品S7', '恒温箱B2'] }] },
  { id: 'request', category: 'control', text: '请解释开放提取是什么。', gold: [] },
]
