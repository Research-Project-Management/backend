import {
  CslName,
  CslDate,
} from '@/modules/library/citation/types/csl-json.types';
import {
  VIETNAMESE_FAMILY_NAMES,
  VIETNAMESE_COMPOUND_SURNAMES,
  VIETNAMESE_MIDDLE_NAMES,
  isVietnameseName,
  parseCreatorString,
  isInstitutionName,
} from '@/modules/library/core';
import { ContributorLike } from './csl-json.mapper';

export class CslNameMapper {
  private static readonly VIETNAMESE_SURNAMES = VIETNAMESE_FAMILY_NAMES;
  private static readonly VIETNAMESE_COMPOUND_SURNAMES =
    VIETNAMESE_COMPOUND_SURNAMES;

  private static isVietnameseName(parts: string[]): boolean {
    if (parts.length < 2) return false;
    const joined = parts.join(' ');
    if (isVietnameseName(joined)) return true;
    const firstLower = parts[0].toLowerCase();
    if (!this.VIETNAMESE_SURNAMES.has(firstLower)) return false;
    return (
      parts.length >= 3 ||
      (parts.length === 2 &&
        VIETNAMESE_MIDDLE_NAMES.has(parts[1].toLowerCase()))
    );
  }

  public static parseCslDate(dateStr: string): CslDate | undefined {
    if (!dateStr) return undefined;
    const match = dateStr.trim().match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/);
    if (match) {
      const parts: number[] = [Number(match[1])];
      if (match[2]) parts.push(Number(match[2]));
      if (match[3]) parts.push(Number(match[3]));
      return { 'date-parts': [parts] };
    }
    return undefined;
  }

  public static formatCslName(contrib: ContributorLike): CslName {
    const attachShort = (target: CslName): CslName => {
      if (contrib.shortName && contrib.shortName.trim()) {
        target.short = contrib.shortName.trim();
      }
      return target;
    };

    if (contrib.fieldMode === 1 || contrib.fieldMode === '1') {
      const name =
        contrib.fullName?.trim() ||
        contrib.name?.trim() ||
        contrib.lastName?.trim() ||
        'Anonymous';
      return attachShort({ literal: name });
    }

    if (contrib.lastName && contrib.lastName.trim()) {
      const stripDegrees = (s: string) =>
        s
          .replace(
            /^(?:(?:p?gs|ts(?:kh)?|ths|cn|ks|bs|dr|prof|ph\.?d)\.?\s*)+/gi,
            '',
          )
          .trim();
      const rawLast = stripDegrees(contrib.lastName.trim());
      const rawFirst = contrib.firstName
        ? stripDegrees(contrib.firstName.trim())
        : '';

      if (!rawFirst && rawLast.includes(' ')) {
        return attachShort(this.parseStringName(rawLast));
      }

      if (rawFirst && !rawFirst.includes(',')) {
        const firstParts = rawFirst.split(/\s+/);
        const lastParts = rawLast.split(/\s+/);
        if (
          firstParts.length >= 1 &&
          lastParts.length === 1 &&
          this.VIETNAMESE_SURNAMES.has(firstParts[0].toLowerCase()) &&
          !this.VIETNAMESE_SURNAMES.has(lastParts[0].toLowerCase())
        ) {
          return attachShort(this.parseStringName(`${rawFirst} ${rawLast}`));
        }
      }

      return attachShort({
        family: rawLast,
        given: rawFirst || undefined,
      });
    }

    const fallbackFull =
      contrib.fullName?.trim() ||
      contrib.name?.trim() ||
      contrib.firstName?.trim();
    if (fallbackFull) {
      return attachShort(this.parseStringName(fallbackFull));
    }

    return { family: 'Anonymous' };
  }

  public static parseStringName(raw: string): CslName {
    const trimmed = (raw || '')
      .trim()
      .replace(
        /^(?:(?:p?gs|ts(?:kh)?|ths|cn|ks|bs|dr|prof|ph\.?d)\.?\s*)+/gi,
        '',
      )
      .trim()
      .replace(/\s+/g, ' ');
    if (!trimmed) return { family: 'Anonymous' };

    const institutionalPattern =
      /(organization|consortium|association|institute|university|laboratory|committee|team|group|corporation|inc\.|llc|agency|department|ministry|academy|bureau|council|center|centre|foundation|society|openai|google|microsoft|meta|deepmind|who|unesco|ieee|acm|đại học|học viện|viện|trung tâm|bộ giáo dục|bộ y tế|bộ khoa học|tổng cục|cục|sở|ngân hàng|ban quản lý|hội đồng|liên minh)/i;
    if (
      (isInstitutionName(trimmed) || institutionalPattern.test(trimmed)) &&
      !trimmed.includes(',')
    ) {
      return { literal: trimmed };
    }

    if (trimmed.includes(',')) {
      const parts = trimmed.split(',').map((p) => p.trim());
      return {
        family: parts[0] || 'Anonymous',
        given: parts.slice(1).join(' ') || undefined,
      };
    }

    const parts = trimmed.split(' ');
    if (parts.length === 1) {
      return { family: parts[0] };
    }

    if (this.isVietnameseName(parts)) {
      if (parts.length >= 3) {
        const potentialCompound = `${parts[0]} ${parts[1]}`.toLowerCase();
        if (this.VIETNAMESE_COMPOUND_SURNAMES.has(potentialCompound)) {
          return {
            family: `${parts[0]} ${parts[1]}`,
            given: parts.slice(2).join(' ') || undefined,
          };
        }
      }
      return {
        family: parts[0],
        given: parts.slice(1).join(' ') || undefined,
      };
    }

    if (
      parts.length >= 3 &&
      /^(?:jr\.?|sr\.?|ii|iii|iv|v)$/i.test(parts[parts.length - 1])
    ) {
      const suffix = parts.pop()!;
      const fam = parts.pop() || 'Anonymous';
      const giv = parts.join(' ');
      return { family: fam, given: giv ? `${giv} ${suffix}` : suffix };
    }

    const parsedCreator = parseCreatorString(trimmed, 0, 'author');
    if (parsedCreator.fieldMode === 1) {
      return { literal: parsedCreator.fullName || trimmed };
    }
    if (parsedCreator.lastName) {
      return {
        family: parsedCreator.lastName,
        given: parsedCreator.firstName || undefined,
      };
    }

    const family = parts.pop() || 'Anonymous';
    const given = parts.join(' ');
    return { family, given };
  }
}
