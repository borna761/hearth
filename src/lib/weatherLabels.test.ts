import { describe, it, expect } from 'vitest';
import { aqiCategory, uvCategory, windDirectionLabel } from './weatherLabels';

describe('aqiCategory', () => {
	it('maps the US AQI scale to its EPA category labels', () => {
		expect(aqiCategory(0)).toBe('Good');
		expect(aqiCategory(50)).toBe('Good');
		expect(aqiCategory(51)).toBe('Moderate');
		expect(aqiCategory(100)).toBe('Moderate');
		expect(aqiCategory(101)).toBe('Unhealthy for sensitive groups');
		expect(aqiCategory(150)).toBe('Unhealthy for sensitive groups');
		expect(aqiCategory(151)).toBe('Unhealthy');
		expect(aqiCategory(200)).toBe('Unhealthy');
		expect(aqiCategory(201)).toBe('Very unhealthy');
		expect(aqiCategory(300)).toBe('Very unhealthy');
		expect(aqiCategory(301)).toBe('Hazardous');
		expect(aqiCategory(500)).toBe('Hazardous');
	});
});

describe('uvCategory', () => {
	it('maps the UV index scale to its standard category labels', () => {
		expect(uvCategory(0)).toBe('Low');
		expect(uvCategory(2.9)).toBe('Low');
		expect(uvCategory(3)).toBe('Moderate');
		expect(uvCategory(5.9)).toBe('Moderate');
		expect(uvCategory(6)).toBe('High');
		expect(uvCategory(7.9)).toBe('High');
		expect(uvCategory(8)).toBe('Very high');
		expect(uvCategory(10.9)).toBe('Very high');
		expect(uvCategory(11)).toBe('Extreme');
	});
});

describe('windDirectionLabel', () => {
	it('maps a compass bearing to its 16-point abbreviation', () => {
		expect(windDirectionLabel(0)).toBe('N');
		expect(windDirectionLabel(90)).toBe('E');
		expect(windDirectionLabel(180)).toBe('S');
		expect(windDirectionLabel(270)).toBe('W');
		expect(windDirectionLabel(45)).toBe('NE');
	});

	it('wraps past 360 rather than throwing or returning undefined', () => {
		expect(windDirectionLabel(360)).toBe('N');
		expect(windDirectionLabel(370)).toBe('N');
	});
});
