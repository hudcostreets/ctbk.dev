import { describe, expect, it } from 'vitest';
import { detectIdKind } from './index';

describe('detectIdKind', () => {
	it('classifies each station id form', () => {
		expect([
			'lafayette+classon',
			'w-52-st+11-ave',
			'lafayette-ave-classon-ave',
			'w52+11',
			'4+99',
			'4452.01',
			'JC115',
			'66db2fd0-0aca-11e7-82f6-3863bb44ef7c',
		].map(detectIdKind)).toEqual(['slug', 'slug', 'slug', 'slug', 'slug', 'short_name', 'short_name', 'uuid']);
	});
});
