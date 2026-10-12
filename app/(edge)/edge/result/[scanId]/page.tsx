import ResultView from '@/components/edge/ResultView';export default async function Page({params}:{params:Promise<{scanId:string}>}){return <ResultView scanId={(await params).scanId}/>;}
