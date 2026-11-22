/**
 * 虚构归档材料以 Vite ?raw 方式打包进应用，
 * “一键载入示例归档”无需任何网络请求即可使用。
 */
import f01 from '../../sample-archive/01-浙江-采购意向-ZC2024-017.txt?raw';
import f02 from '../../sample-archive/02-浙江-招标公告-ZC2024-017-网页归档.txt?raw';
import f03 from '../../sample-archive/03-浙江-招标公告-ZC2024-017-打印件副本.txt?raw';
import f04 from '../../sample-archive/04-浙江-更正公告-预算变动-ZC2024-017.txt?raw';
import f05 from '../../sample-archive/05-浙江-延期公告-时限调整-ZC2024-017.txt?raw';
import f06 from '../../sample-archive/06-浙江-中标结果-ZC2024-017-附件摘要.txt?raw';
import f07 from '../../sample-archive/07-安徽-撤销终止-HF2024-XM-082.txt?raw';
import f08 from '../../sample-archive/08-安徽-重新采购公告-HF2024-XM-082-2.txt?raw';
import f09 from '../../sample-archive/09-四川-互斥标段公告A-SC2024-WZ-305.txt?raw';
import f10 from '../../sample-archive/10-四川-互斥标段公告B-SC2024-WZ-305.txt?raw';
import f11 from '../../sample-archive/11-四川-成交公告A包-复制文本-SC2024-WZ-305.txt?raw';
import f12 from '../../sample-archive/12-浙江-附件摘要-评标情况-ZC2024-017.txt?raw';
// 疑似拆分采购组合分析样例（16 份）
import s01 from '../../sample-archive/split/01-浙江-杭州-智慧教室-A-2023.txt?raw';
import s02 from '../../sample-archive/split/02-浙江-杭州-智慧教室-B-2023.txt?raw';
import s03 from '../../sample-archive/split/03-浙江-杭州-智慧教室-C-2024.txt?raw';
import s04 from '../../sample-archive/split/04-浙江-宁波-网络改造-A-2024.txt?raw';
import s05 from '../../sample-archive/split/05-浙江-宁波-网络改造-B-2024.txt?raw';
import s06 from '../../sample-archive/split/06-安徽-合肥-政务云-A-2024.txt?raw';
import s07 from '../../sample-archive/split/07-安徽-合肥-政务云-B-2024.txt?raw';
import s08 from '../../sample-archive/split/08-四川-成都-应急物资-A-2024.txt?raw';
import s09 from '../../sample-archive/split/09-四川-成都-应急物资-B-联合采购-2024.txt?raw';
import s10 from '../../sample-archive/split/10-四川-成都-办公家具-2024.txt?raw';
import s11 from '../../sample-archive/split/11-浙江-杭州-网络改造-A-2023.txt?raw';
import s12 from '../../sample-archive/split/12-浙江-杭州-网络改造-B-2023.txt?raw';
import s13 from '../../sample-archive/split/13-浙江-绍兴-智慧教室-A标段-2024.txt?raw';
import s14 from '../../sample-archive/split/14-浙江-绍兴-智慧教室-B标段-2024.txt?raw';
import s15 from '../../sample-archive/split/15-四川-成都-应急物资-C-2024.txt?raw';
import s16 from '../../sample-archive/split/16-浙江-宁波-网络改造-C-2024.txt?raw';
import type { ImportFileInput } from '../core/engine';

const pairs: [string, string][] = [
  ['01-浙江-采购意向-ZC2024-017.txt', f01],
  ['02-浙江-招标公告-ZC2024-017-网页归档.txt', f02],
  ['03-浙江-招标公告-ZC2024-017-打印件副本.txt', f03],
  ['04-浙江-更正公告-预算变动-ZC2024-017.txt', f04],
  ['05-浙江-延期公告-时限调整-ZC2024-017.txt', f05],
  ['06-浙江-中标结果-ZC2024-017-附件摘要.txt', f06],
  ['07-安徽-撤销终止-HF2024-XM-082.txt', f07],
  ['08-安徽-重新采购公告-HF2024-XM-082-2.txt', f08],
  ['09-四川-互斥标段公告A-SC2024-WZ-305.txt', f09],
  ['10-四川-互斥标段公告B-SC2024-WZ-305.txt', f10],
  ['11-四川-成交公告A包-复制文本-SC2024-WZ-305.txt', f11],
  ['12-浙江-附件摘要-评标情况-ZC2024-017.txt', f12],
];

const splitPairs: [string, string][] = [
  ['S01-杭州拱墅-智慧教室-A-2023.txt', s01],
  ['S02-杭州拱墅-智慧教室-B-2023.txt', s02],
  ['S03-杭州拱墅-智慧教室-C-2024.txt', s03],
  ['S04-宁波鄞州-网络改造-A-2024.txt', s04],
  ['S05-宁波鄞州-网络改造-B-2024.txt', s05],
  ['S06-合肥-政务云-A-2024.txt', s06],
  ['S07-合肥-政务云-B-2024.txt', s07],
  ['S08-成都-应急物资-A-2024.txt', s08],
  ['S09-成都-应急物资-B-联合采购-2024.txt', s09],
  ['S10-成都-办公家具-2024.txt', s10],
  ['S11-杭州西湖-网络改造-A-2023.txt', s11],
  ['S12-杭州西湖-网络改造-B-2023.txt', s12],
  ['S13-绍兴柯桥-智慧教室-A标段-2024.txt', s13],
  ['S14-绍兴柯桥-智慧教室-B标段-2024.txt', s14],
  ['S15-成都-应急物资-C-2024.txt', s15],
  ['S16-宁波鄞州-网络改造-C-2024.txt', s16],
];

export const SAMPLE_FILES: ImportFileInput[] = pairs.map(([fileName, text]) => ({ fileName, text }));

/** 疑似拆分采购组合分析专用样例（含门槛切换、短期同类、独立计划、联合采购、链路裁决更正） */
export const SPLIT_SAMPLE_FILES: ImportFileInput[] = splitPairs.map(([fileName, text]) => ({ fileName, text }));
