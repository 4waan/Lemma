import React from 'react';
import {Composition} from 'remotion';
import {Pitch, type PitchProps} from './Pitch';
import timeline from './timeline.json';

const common = {
	component: Pitch,
	durationInFrames: timeline.total,
	fps: timeline.fps,
	width: 1920,
	height: 1080,
};

export const RemotionRoot: React.FC = () => (
	<>
		<Composition id="Pitch" {...common} defaultProps={{guide: false, voices: {}} satisfies PitchProps} />
		<Composition id="PitchGuide" {...common} defaultProps={{guide: true, voices: {}} satisfies PitchProps} />
	</>
);
