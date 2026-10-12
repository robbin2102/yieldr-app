import ScanView from '@/components/edge/ScanView';export default async function Page({params}:{params:Promise<{scanId:string}>}){return <ScanView scanId={(await params).scanId}/>;}
