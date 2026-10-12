import type {Metadata} from 'next';
import './edge.css';
export const metadata:Metadata={title:'Yieldr · Find your edge',description:'Understand the evidence behind your Fomo trading behavior.',icons:{icon:'/edge/yieldr-icon.png'}};
export default function EdgeLayout({children}:{children:React.ReactNode}){return <div className="edge-app"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;600&family=Manrope:wght@400;600;700;800&display=swap"/>{children}</div>;}
