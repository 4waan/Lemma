import React, {useEffect, useState} from 'react';
import {continueRender, delayRender, Easing, interpolate, staticFile} from 'remotion';

export const C = {
	bg: '#0B1113',
	surface: '#121A1C',
	surface2: '#18242A',
	line: '#24343A',
	text: '#EDF3F1',
	muted: '#8FA3A0',
	faint: '#55686A',
	mint: '#5FE7BB',
	mintMid: '#44CDA0',
	mintDeep: '#17906B',
	red: '#FF6B6B',
	amber: '#F5B84B',
};

export const F = {
	head: 'Lexend, sans-serif',
	body: '"Instrument Sans", sans-serif',
	mono: '"JetBrains Mono", monospace',
};

/** 0 → 1 between frames a and b, eased, clamped. */
export const ease = (f: number, a: number, b: number) =>
	interpolate(f, [a, b], [0, 1], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
		easing: Easing.bezier(0.2, 0.8, 0.2, 1),
	});

/** Linear 0 → 1 between a and b, clamped. */
export const lin = (f: number, a: number, b: number) =>
	interpolate(f, [a, b], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});

/** Fade and rise in from frame a. */
export const rise = (f: number, a: number, distance = 24, length = 14): React.CSSProperties => {
	const p = ease(f, a, a + length);
	return {opacity: p, transform: `translateY(${(1 - p) * distance}px)`};
};

const FONTS: [string, string, string][] = [
	['Lexend', 'fonts/lexend-latin.woff2', '100 900'],
	['Instrument Sans', 'fonts/instrument-sans-latin.woff2', '400 700'],
	['JetBrains Mono', 'fonts/jetbrains-mono-latin.woff2', '100 800'],
];

/** Loads the brand fonts before the first frame renders. */
export const useFonts = () => {
	const [handle] = useState(() => delayRender('fonts'));
	useEffect(() => {
		Promise.all(
			FONTS.map(([family, file, weight]) => {
				const face = new FontFace(family, `url(${staticFile(file)}) format('woff2')`, {weight});
				return face.load().then((loaded) => document.fonts.add(loaded));
			}),
		)
			.then(() => continueRender(handle))
			.catch((error) => {
				console.error(error);
				continueRender(handle);
			});
	}, [handle]);
};

/** Props every answer scene receives: frames since the answer began and each phrase's start. */
export type SceneProps = {t: number; dur: number; ph: number[]};
